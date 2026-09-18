"""One logical send reaches the customer at most once.

Every test here drives the real task through a specific failure and then asserts on what the provider
actually received -- ``FakeEmailProvider.sent`` / ``FakeWhatsAppProvider.sent`` are the wire, so a
duplicate there is a duplicate a customer would have read.
"""

from __future__ import annotations

import threading
import uuid
from urllib.parse import parse_qs, urlsplit

import pytest
from django.db import connection
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.core.tenancy.context import tenant_context
from apps.messaging import services
from apps.messaging.models import EmailMessage, WhatsAppAccount, WhatsAppMessage
from apps.messaging.providers.fake import FakeEmailProvider, FakeWhatsAppProvider
from apps.messaging.tasks import reconcile_stuck_sends, send_email_message, send_whatsapp_message

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _reset_fakes():
    FakeEmailProvider.reset()
    FakeWhatsAppProvider.reset()
    yield
    FakeEmailProvider.reset()
    FakeWhatsAppProvider.reset()


def _connect(client, reauthenticate):
    reauthenticate(client)
    resp = client.post("/api/v1/email/accounts/connect/", {"provider": "gmail"}, format="json")
    state = parse_qs(urlsplit(resp.json()["authorization_url"]).query)["state"][0]
    client.get(f"/api/v1/email/accounts/callback/?state={state}&code=owner")


def _queue_email(org, owner_client, crm, reauthenticate) -> tuple[uuid.UUID, uuid.UUID]:
    """Create a QUEUED email without letting the delivery task run, and return (message id, sender)."""
    _connect(owner_client, reauthenticate)
    contact = crm.make_contact(org, email="grace@example.com")
    resp = owner_client.post(
        "/api/v1/email/messages/",
        {"to": ["grace@example.com"], "subject": "Hello", "body": "Hi Grace", "contact_id": str(contact.pk)},
        format="json",
    )
    assert resp.status_code in (200, 201), resp.content
    message_id = uuid.UUID(resp.json()["id"])
    with tenant_context(org.org.pk):
        row = EmailMessage.objects.get(pk=message_id)
        # The API answers before the task runs; if a previous commit hook already delivered it, reset.
        EmailMessage.objects.filter(pk=message_id).update(
            status=EmailMessage.Status.QUEUED,
            claimed_at=None,
            provider_attempted_at=None,
            send_attempts=0,
            provider_message_id="",
        )
        sender = row.sent_by_id
    assert sender is not None
    FakeEmailProvider.reset()
    return message_id, sender


def _run_send(org, message_id, sender):
    return send_email_message(
        message_id=str(message_id), organization_id=str(org.org.pk), actor_membership_id=str(sender)
    )


def _row(org, message_id) -> EmailMessage:
    with tenant_context(org.org.pk):
        return EmailMessage.objects.get(pk=message_id)


# --------------------------------------------------------------------------- duplicate task delivery


def test_same_task_executed_twice_sends_once(org_a, owner_client, crm, reauthenticate):
    """Celery redelivers a message it already ran. The second run must claim nothing."""
    message_id, sender = _queue_email(org_a, owner_client, crm, reauthenticate)

    assert _run_send(org_a, message_id, sender) == "sent"
    assert _run_send(org_a, message_id, sender) == "skipped"

    assert len(FakeEmailProvider.sent) == 1
    row = _row(org_a, message_id)
    assert row.status == EmailMessage.Status.SENT
    assert row.send_attempts == 1


def test_retry_after_timeout_does_not_send_twice(org_a, owner_client, crm, reauthenticate):
    """A worker that lost its broker ack retries the identical task while the first run finished."""
    message_id, sender = _queue_email(org_a, owner_client, crm, reauthenticate)
    assert _run_send(org_a, message_id, sender) == "sent"
    first = _row(org_a, message_id).provider_message_id

    for _ in range(3):
        assert _run_send(org_a, message_id, sender) == "skipped"

    assert len(FakeEmailProvider.sent) == 1
    assert _row(org_a, message_id).provider_message_id == first


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_concurrent_workers_claim_exactly_one(org_a, owner_client, crm, reauthenticate):
    """Two workers race for the same queued message. The conditional UPDATE decides; one of them loses."""
    message_id, sender = _queue_email(org_a, owner_client, crm, reauthenticate)
    results: list[str] = []
    barrier = threading.Barrier(2)

    def worker():
        barrier.wait(timeout=10)
        try:
            results.append(_run_send(org_a, message_id, sender))
        finally:
            connection.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert sorted(results) == ["sent", "skipped"]
    assert len(FakeEmailProvider.sent) == 1
    assert _row(org_a, message_id).status == EmailMessage.Status.SENT


# --------------------------------------------------------------------------- crash after the provider


def test_worker_crash_after_provider_call_is_reconciled_not_resent(org_a, owner_client, crm, reauthenticate):
    """The provider accepted the message, then the worker died before recording it.

    The row is left SENDING with ``provider_attempted_at`` set. Reconciliation asks the provider (Gmail
    can find a send by the Message-ID we stamped on it), finds it, and settles SENT -- without sending
    a second copy.
    """
    message_id, sender = _queue_email(org_a, owner_client, crm, reauthenticate)
    FakeEmailProvider.crash_next_send = True

    with pytest.raises(RuntimeError):
        _run_send(org_a, message_id, sender)

    row = _row(org_a, message_id)
    assert row.status == EmailMessage.Status.SENDING
    assert row.provider_attempted_at is not None  # the crash window is recorded, not guessed at
    assert len(FakeEmailProvider.sent) == 1

    _age_claim(org_a, message_id)
    assert reconcile_stuck_sends() == 1

    row = _row(org_a, message_id)
    assert row.status == EmailMessage.Status.SENT
    assert row.provider_message_id
    assert len(FakeEmailProvider.sent) == 1  # still exactly one message on the wire
    assert _audit_actions(org_a, message_id) >= {"email.send_reconciled"}


def test_db_error_after_provider_succeeds_leaves_no_duplicate(org_a, owner_client, crm, reauthenticate, monkeypatch):
    """The provider succeeded and then the settle transaction blew up.

    The claim and ``provider_attempted_at`` were committed *before* the provider call, so the failure
    cannot roll the message back to QUEUED and cannot cause a resend.
    """
    message_id, sender = _queue_email(org_a, owner_client, crm, reauthenticate)

    def explode(message, result):
        raise RuntimeError("database went away while recording the result")

    monkeypatch.setattr(services, "settle_email_sent", explode)
    with pytest.raises(RuntimeError):
        _run_send(org_a, message_id, sender)

    row = _row(org_a, message_id)
    assert row.status == EmailMessage.Status.SENDING
    assert row.status != EmailMessage.Status.QUEUED
    assert len(FakeEmailProvider.sent) == 1

    monkeypatch.undo()
    _age_claim(org_a, message_id)
    reconcile_stuck_sends()
    assert _row(org_a, message_id).status == EmailMessage.Status.SENT
    assert len(FakeEmailProvider.sent) == 1


def test_crash_before_provider_call_is_safely_requeued(org_a, owner_client, crm, reauthenticate):
    """Claimed but never handed to the provider: provably not sent, so a retry is safe."""
    message_id, _sender = _queue_email(org_a, owner_client, crm, reauthenticate)
    now = timezone.now()
    with tenant_context(org_a.org.pk):
        EmailMessage.objects.filter(pk=message_id).update(
            status=EmailMessage.Status.SENDING, claimed_at=now, provider_attempted_at=None, send_attempts=1
        )

    _age_claim(org_a, message_id)
    assert reconcile_stuck_sends() == 1

    row = _row(org_a, message_id)
    assert row.status == EmailMessage.Status.QUEUED
    assert row.claimed_at is None
    assert len(FakeEmailProvider.sent) == 0

    assert _run_send(org_a, message_id, row.sent_by_id) == "sent"
    assert len(FakeEmailProvider.sent) == 1


# --------------------------------------------------------------------------- provider-side protection


def test_provider_duplicate_protection_uses_the_idempotency_key(org_a, owner_client, crm, reauthenticate):
    """Belt and braces: even if the claim were bypassed, the key stops a second message going out."""
    message_id, sender = _queue_email(org_a, owner_client, crm, reauthenticate)
    assert _run_send(org_a, message_id, sender) == "sent"
    row = _row(org_a, message_id)
    assert FakeEmailProvider.sent[0].idempotency_key == str(row.idempotency_key)

    # Force the row back to QUEUED as a redelivery that dodged the state machine would, and re-send.
    with tenant_context(org_a.org.pk):
        EmailMessage.objects.filter(pk=message_id).update(status=EmailMessage.Status.QUEUED, claimed_at=None)
    assert _run_send(org_a, message_id, sender) == "sent"

    # The provider de-duplicated on the key: one message on the wire, same provider id both times.
    assert len(FakeEmailProvider.sent) == 1
    assert _row(org_a, message_id).provider_message_id == row.provider_message_id


def test_idempotency_key_is_unique_per_message(org_a, owner_client, crm, reauthenticate):
    first, _sender = _queue_email(org_a, owner_client, crm, reauthenticate)
    second, _ = _queue_email(org_a, owner_client, crm, reauthenticate)
    assert _row(org_a, first).idempotency_key != _row(org_a, second).idempotency_key


# --------------------------------------------------------------------------- whatsapp (no provider key)


def test_whatsapp_crash_ends_unconfirmed_and_is_never_resent(org_a, owner_client, crm, reauthenticate):
    """The Cloud API cannot confirm a send for us, so recovery stops at UNCONFIRMED by design."""
    contact = crm.make_contact(org_a, phone="+15550100")
    with tenant_context(org_a.org.pk):
        contact.whatsapp_opt_in = True
        contact.save(update_fields=["whatsapp_opt_in"])
        account = WhatsAppAccount.objects.create(
            phone_number_id="pn-1", access_token_enc=_encrypt("wa-token"), status="connected"
        )
        message = WhatsAppMessage.objects.create(
            account=account,
            direction="outbound",
            status=WhatsAppMessage.Status.QUEUED,
            wa_id="15550100",
            message_type="text",
            body="Hi",
            contact=contact,
            sent_by=org_a.owner_membership,
        )
    FakeWhatsAppProvider.crash_next_send = True
    with pytest.raises(RuntimeError):
        send_whatsapp_message(
            message_id=str(message.pk),
            organization_id=str(org_a.org.pk),
            actor_membership_id=str(org_a.owner_membership.pk),
        )
    assert len(FakeWhatsAppProvider.sent) == 1

    _age_claim(org_a, message.pk, model=WhatsAppMessage)
    reconcile_stuck_sends()

    with tenant_context(org_a.org.pk):
        row = WhatsAppMessage.objects.get(pk=message.pk)
    assert row.status == WhatsAppMessage.Status.UNCONFIRMED
    assert len(FakeWhatsAppProvider.sent) == 1  # reconciliation did not replay it


# --------------------------------------------------------------------------- tenant isolation


def test_reconciliation_stays_inside_the_owning_tenant(org_a, org_b, owner_client, crm, reauthenticate):
    """The sweeper runs cross-tenant; each message must still be settled in its own org's context."""
    message_id, _sender = _queue_email(org_a, owner_client, crm, reauthenticate)
    with tenant_context(org_a.org.pk):
        EmailMessage.objects.filter(pk=message_id).update(
            status=EmailMessage.Status.SENDING, claimed_at=timezone.now(), provider_attempted_at=None
        )
    _age_claim(org_a, message_id)
    reconcile_stuck_sends()

    with tenant_context(org_b.org.pk):
        assert not EmailMessage.objects.filter(pk=message_id).exists()
    with tenant_context(org_a.org.pk):
        assert EmailMessage.objects.get(pk=message_id).status == EmailMessage.Status.QUEUED


# --------------------------------------------------------------------------- helpers


def _age_claim(org, message_id, model=EmailMessage):
    """Backdate the claim so the sweeper considers the owning worker dead."""
    from django.conf import settings

    old = timezone.now() - settings.MESSAGING_SEND_RECONCILE_AFTER * 2
    with tenant_context(org.org.pk):
        model.objects.filter(pk=message_id).update(claimed_at=old)


def _encrypt(value: str) -> str:
    from apps.core import crypto

    return crypto.encrypt(value)


def _audit_actions(org, message_id) -> set[str]:
    with tenant_context(org.org.pk):
        return set(AuditEvent.objects.filter(resource_id=message_id).values_list("action", flat=True))
