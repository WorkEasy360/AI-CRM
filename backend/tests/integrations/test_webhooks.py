"""Webhooks: signed outbound deliveries with retries, and the hardened inbound receiver."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import timedelta

import httpx
import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.contacts.models import Contact
from apps.core.tenancy.context import system_context, tenant_context
from apps.integrations import delivery, events, signing
from apps.integrations.models import (
    ConnectionStatus,
    InboundEvent,
    IntegrationEvent,
    IntegrationRecordMap,
    OutboundDelivery,
    WebhookSubscription,
)
from apps.notifications.models import Notification
from tests.integrations.conftest import json_body

pytestmark = pytest.mark.security


def _create_webhook(client, **overrides):
    payload = {
        "name": "CRM feed",
        "url": "https://hooks.example.com/keel",
        "event_types": ["contact.created"],
        **overrides,
    }
    return client.post("/api/v1/integrations/webhooks/", payload, format="json")


def _emit_and_deliver(org, contact_factory) -> list[OutboundDelivery]:
    """Create a contact (emits the event in the CRM transaction) and run dispatch + delivery inline."""
    contact = contact_factory(org)
    with tenant_context(org.org.pk, reason="test.dispatch"):
        event = IntegrationEvent.objects.get(entity_id=contact.pk, event_type="contact.created")
        created = delivery.dispatch(event)
        for item in created:
            delivery.attempt(item)
        return [OutboundDelivery.objects.get(pk=d.pk) for d in created]


# ----------------------------------------------------------------------------- outbound: management


def test_create_webhook_requires_reauth_and_returns_secret_once(org_a, owner_client, reauthenticate):
    assert _create_webhook(owner_client).status_code == 403
    reauthenticate(owner_client)
    resp = _create_webhook(owner_client)
    assert resp.status_code == 201, resp.content
    secret = resp.json()["secret"]
    assert secret.startswith("whsec_")
    listed = owner_client.get("/api/v1/integrations/webhooks/").json()["results"][0]
    detail = owner_client.get(f"/api/v1/integrations/webhooks/{resp.json()['id']}/").json()
    for body in (listed, detail):
        assert "secret" not in body and "secret_enc" not in body
        assert secret not in json.dumps(body)
    with tenant_context(org_a.org.pk):
        stored = WebhookSubscription.objects.get(pk=resp.json()["id"])
    assert secret not in stored.secret_enc


@pytest.mark.parametrize("role", ["sales_manager", "sales_rep", "viewer"])
def test_only_admins_manage_webhooks(org_a, make_member, client_for, reauthenticate, role):
    member = make_member(org_a, role)
    client = client_for(member.user, member)
    reauthenticate(client)
    assert _create_webhook(client).status_code == 403
    assert client.get("/api/v1/integrations/webhooks/").status_code == 403


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:3000/callback",
        "https://127.0.0.1/hook",
        "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "https://metadata.google.internal/computeMetadata/v1/",
        "https://10.0.0.8/internal",
    ],
)
def test_webhook_destination_ssrf_rejected(owner_client, reauthenticate, url):
    reauthenticate(owner_client)
    resp = _create_webhook(owner_client, url=url)
    assert resp.status_code == 400
    assert "url" in json.dumps(resp.json())


def test_unknown_or_internal_events_rejected(owner_client, reauthenticate):
    reauthenticate(owner_client)
    for events_ in (["user.password_changed"], ["auth.login"], [], ["contact.created", "session.created"]):
        assert _create_webhook(owner_client, event_types=events_).status_code == 400


# ----------------------------------------------------------------------------- outbound: delivery


def test_delivery_is_signed_thin_and_verifiable(org_a, crm, remote):
    secret = "whsec_known-secret"
    with tenant_context(org_a.org.pk):
        from apps.core import crypto

        crm.make_webhook_subscription(org_a, secret_enc=crypto.encrypt(secret))
    events.invalidate_targets(org_a.org.pk)
    remote.on("POST", "/keel", 200, {})
    (result,) = _emit_and_deliver(org_a, lambda org: crm.make_contact(org, first_name="Ada", email="ada@example.com"))
    assert result.status == OutboundDelivery.Status.SUCCEEDED
    request = remote.calls("POST", "/keel")[0]
    body = request.content
    ok, _ = signing.verify(request.headers["keel-signature"], body, [secret])
    assert ok
    assert request.headers["keel-event-id"] == str(result.event_id)
    payload = json.loads(body)
    assert payload["type"] == "contact.created"
    # thin by default: identifiers only, no personal data
    assert payload["data"] == {"object": "contact", "id": payload["data"]["id"]}
    assert "ada@example.com" not in body.decode()


def test_include_data_sends_only_allowlisted_fields(org_a, crm, remote):
    with tenant_context(org_a.org.pk):
        crm.make_webhook_subscription(org_a, include_data=True)
    events.invalidate_targets(org_a.org.pk)
    remote.on("POST", "/keel", 204)
    _emit_and_deliver(
        org_a,
        lambda org: crm.make_contact(org, first_name="Ada", email="ada@example.com", description="private note"),
    )
    attributes = json_body(remote.calls("POST", "/keel")[0])["data"]["attributes"]
    assert attributes["email"] == "ada@example.com"
    assert "description" not in attributes and "custom_data" not in attributes and "owner_id" not in attributes
    assert "private note" not in json.dumps(attributes)


def test_retry_with_backoff_then_success_and_stable_event_id(org_a, crm, remote):
    with tenant_context(org_a.org.pk):
        crm.make_webhook_subscription(org_a)
    events.invalidate_targets(org_a.org.pk)
    responses = iter([httpx.Response(503), httpx.Response(429, headers={"retry-after": "120"}), httpx.Response(200)])
    remote.handle("POST", "/keel", lambda r: next(responses))
    (first,) = _emit_and_deliver(org_a, crm.make_contact)
    assert first.status == OutboundDelivery.Status.PENDING and first.attempts == 1
    assert first.next_attempt_at > timezone.now()
    with tenant_context(org_a.org.pk):
        delivery.attempt(first)
        first.refresh_from_db()
        assert first.status == OutboundDelivery.Status.PENDING
        assert first.next_attempt_at >= timezone.now() + timedelta(seconds=115)  # Retry-After respected
        delivery.attempt(first)
        first.refresh_from_db()
    assert first.status == OutboundDelivery.Status.SUCCEEDED and first.attempts == 3
    ids = {r.headers["keel-event-id"] for r in remote.calls("POST", "/keel")}
    assert ids == {str(first.event_id)}


def test_permanent_failure_is_not_retried(org_a, crm, remote):
    with tenant_context(org_a.org.pk):
        crm.make_webhook_subscription(org_a)
    events.invalidate_targets(org_a.org.pk)
    remote.on("POST", "/keel", 400, {"error": "bad"})
    (result,) = _emit_and_deliver(org_a, crm.make_contact)
    assert result.status == OutboundDelivery.Status.FAILED and result.next_attempt_at is None


def test_retries_are_limited(org_a, crm, remote, settings):
    settings.INTEGRATIONS_MAX_DELIVERY_ATTEMPTS = 3
    with tenant_context(org_a.org.pk):
        crm.make_webhook_subscription(org_a)
    events.invalidate_targets(org_a.org.pk)
    remote.on("POST", "/keel", 500)
    (row,) = _emit_and_deliver(org_a, crm.make_contact)
    with tenant_context(org_a.org.pk):
        for _ in range(5):
            delivery.attempt(row)
            row.refresh_from_db()
    assert row.status == OutboundDelivery.Status.DEAD and row.attempts == 3
    assert len(remote.calls("POST", "/keel")) == 3


def test_repeatedly_failing_webhook_is_disabled_and_admins_notified_once(org_a, crm, remote):
    with tenant_context(org_a.org.pk):
        sub = crm.make_webhook_subscription(org_a, consecutive_failures=delivery.WEBHOOK_DISABLE_AFTER_FAILURES - 1)
    events.invalidate_targets(org_a.org.pk)
    remote.on("POST", "/keel", 500)
    _emit_and_deliver(org_a, crm.make_contact)
    with tenant_context(org_a.org.pk):
        sub.refresh_from_db()
        assert sub.status == WebhookSubscription.Status.DISABLED
        assert Notification.objects.filter(kind="integration_alert", entity_id=sub.pk).count() == 1
    # disabled: later CRM changes no longer produce deliveries
    contact = crm.make_contact(org_a)
    with tenant_context(org_a.org.pk):
        assert not IntegrationEvent.objects.filter(entity_id=contact.pk).exists()


def test_delivery_redirect_to_private_address_is_blocked(org_a, crm, remote):
    with tenant_context(org_a.org.pk):
        crm.make_webhook_subscription(org_a)
    events.invalidate_targets(org_a.org.pk)
    remote.on("POST", "/keel", 307, headers={"location": "http://169.254.169.254/latest/meta-data/"})
    (result,) = _emit_and_deliver(org_a, crm.make_contact)
    assert result.status == OutboundDelivery.Status.FAILED
    assert result.error_code == "redirect_not_followed"
    assert len(remote.requests) == 1


def test_secret_rotation_signs_with_both_secrets(org_a, owner_client, reauthenticate, remote):
    reauthenticate(owner_client)
    created = _create_webhook(owner_client).json()
    old = created["secret"]
    rotated = owner_client.post(f"/api/v1/integrations/webhooks/{created['id']}/rotate-secret/", {}, format="json")
    assert rotated.status_code == 200
    new = rotated.json()["secret"]
    assert new != old and rotated.json()["rotation_in_progress"] is True
    remote.on("POST", "/keel", 200)
    resp = owner_client.post(f"/api/v1/integrations/webhooks/{created['id']}/test/", {}, format="json")
    assert resp.status_code == 200 and resp.json()["ok"] is True
    request = remote.calls("POST", "/keel")[-1]
    assert signing.verify(request.headers["keel-signature"], request.content, [new])[0]
    assert signing.verify(request.headers["keel-signature"], request.content, [old])[0]


def test_no_events_recorded_for_organizations_without_integrations(org_a, crm, django_assert_max_num_queries):
    crm.make_contact(org_a)  # warm the per-organization target cache
    with django_assert_max_num_queries(40):
        for _ in range(10):
            crm.make_contact(org_a)
    with tenant_context(org_a.org.pk):
        assert IntegrationEvent.objects.count() == 0


# ----------------------------------------------------------------------------- inbound


@pytest.fixture
def inbound(org_a, owner_client, reauthenticate, connection):
    """Enable the inbound endpoint on the two-way contact connection; returns (path, secret, connection)."""
    reauthenticate(owner_client)
    resp = owner_client.post(f"/api/v1/integrations/connections/{connection.pk}/inbound/", {}, format="json")
    assert resp.status_code == 200, resp.content
    url, secret = resp.json()["url"], resp.json()["secret"]
    path = url[url.index("/api/v1/") :]
    return path, secret, connection


@pytest.fixture(autouse=True)
def _run_on_commit(django_capture_on_commit_callbacks):
    """Inbound processing is scheduled on COMMIT; run those callbacks inside the test transaction."""
    global _capture
    _capture = django_capture_on_commit_callbacks


_capture = None


def _post_inbound(path, secret, payload, *, event_id="evt_1", timestamp=None, signature=None):
    body = json.dumps(payload).encode()
    ts = int(time.time()) if timestamp is None else timestamp
    header = signature if signature is not None else signing.header_value([secret], ts, body)
    with _capture(execute=True):
        return APIClient().generic(
            "POST",
            path,
            body,
            content_type="application/json",
            HTTP_KEEL_SIGNATURE=header,
            HTTP_KEEL_EVENT_ID=event_id,
        )


CONTACT_EVENT = {
    "type": "contact.upsert",
    "data": {"id": "ext-100", "firstName": "Grace", "emailAddress": "grace@example.com"},
}


def test_inbound_signed_event_creates_contact_through_service_layer(org_a, inbound):
    path, secret, connection = inbound
    resp = _post_inbound(path, secret, CONTACT_EVENT)
    assert resp.status_code == 202, resp.content
    with tenant_context(org_a.org.pk):
        contact = Contact.objects.get(email="grace@example.com")
        assert contact.owner_id == connection.connected_by_id  # records.create set ownership
        assert (
            IntegrationRecordMap.objects.get(connection=connection, external_record_id="ext-100").crm_record_id
            == contact.pk
        )
        event = InboundEvent.objects.get(connection=connection, event_id="evt_1")
        assert event.status == InboundEvent.Status.PROCESSED and event.payload == {}
    with system_context("test"):
        from apps.audit.models import AuditEvent

        created = AuditEvent.objects.get(action="contacts.created", resource_id=str(contact.pk))
        assert created.actor_type == "integration"
        assert created.metadata["integration_id"] == str(connection.pk)


@pytest.mark.parametrize(
    ("kind", "status"),
    [("bad_signature", 401), ("wrong_secret", 401), ("stale", 401), ("missing_signature", 401)],
)
def test_inbound_rejects_unauthenticated_requests(org_a, inbound, kind, status):
    path, secret, _ = inbound
    kwargs = {
        "bad_signature": {"signature": f"t={int(time.time())},v1={'0' * 64}"},
        "wrong_secret": {
            "signature": signing.header_value(["whsec_other"], int(time.time()), json.dumps(CONTACT_EVENT).encode())
        },
        "stale": {"timestamp": int(time.time()) - 3600},
        "missing_signature": {"signature": ""},
    }[kind]
    resp = _post_inbound(path, secret, CONTACT_EVENT, **kwargs)
    assert resp.status_code == status
    with tenant_context(org_a.org.pk):
        assert not Contact.objects.filter(email="grace@example.com").exists()
        assert not InboundEvent.objects.exists()


def test_inbound_replay_and_duplicate_are_processed_once(org_a, inbound):
    path, secret, _ = inbound
    first = _post_inbound(path, secret, CONTACT_EVENT, event_id="evt_same")
    replay = _post_inbound(path, secret, CONTACT_EVENT, event_id="evt_same")
    assert first.status_code == 202
    assert replay.status_code == 200 and replay.json()["status"] == "duplicate"
    with tenant_context(org_a.org.pk):
        assert Contact.objects.filter(email="grace@example.com").count() == 1
        assert InboundEvent.objects.count() == 1


def test_inbound_limits_and_schema(org_a, inbound):
    path, secret, _ = inbound
    assert _post_inbound(path, secret, CONTACT_EVENT, event_id="").status_code == 400
    assert _post_inbound(path, secret, {"type": "user.create", "data": {"id": "1"}}).status_code == 422
    assert _post_inbound(path, secret, {"type": "contact.upsert", "data": "nope"}, event_id="e2").status_code == 422
    assert (
        _post_inbound(path, secret, {"type": "contact.upsert", "data": {"firstName": "x"}}, event_id="e3").status_code
        == 422
    )
    big = {"type": "contact.upsert", "data": {"id": "1", "blob": "x" * 300_000}}
    assert _post_inbound(path, secret, big, event_id="e4").status_code == 413
    unknown = path.replace(path.rstrip("/").rsplit("/", 1)[1], "A" * 43)
    assert _post_inbound(unknown, secret, CONTACT_EVENT, event_id="e5").status_code == 404


def test_inbound_rate_limit(org_a, inbound, settings):
    settings.INTEGRATIONS_INBOUND_PER_MINUTE = 2
    path, secret, _ = inbound
    statuses = [_post_inbound(path, secret, CONTACT_EVENT, event_id=f"r{i}").status_code for i in range(4)]
    assert statuses[:2] in ([202, 200], [202, 202]) and statuses[2:] == [429, 429]


def test_inbound_ignores_unmapped_and_security_fields(org_a, inbound):
    path, secret, connection = inbound
    payload = {
        "type": "contact.upsert",
        "data": {
            "id": "ext-7",
            "firstName": "Eve",
            "emailAddress": "eve@example.com",
            "owner_id": str(connection.pk),
            "organization_id": "00000000-0000-0000-0000-000000000000",
            "password": "hunter22",
            "description": "should not be written",
        },
    }
    assert _post_inbound(path, secret, payload, event_id="sec").status_code == 202
    with tenant_context(org_a.org.pk):
        contact = Contact.objects.get(email="eve@example.com")
    assert contact.organization_id == org_a.org.pk
    assert contact.description == ""
    assert contact.owner_id == connection.connected_by_id


def test_inbound_endpoint_of_paused_or_disconnected_connection_is_gone(org_a, inbound, owner_client):
    path, secret, connection = inbound
    with tenant_context(org_a.org.pk):
        type(connection).objects.filter(pk=connection.pk).update(status=ConnectionStatus.DISABLED)
    assert _post_inbound(path, secret, CONTACT_EVENT).status_code == 404


def test_inbound_secret_rotation_accepts_previous_secret_for_overlap(org_a, inbound, owner_client):
    path, old_secret, connection = inbound
    resp = owner_client.post(
        f"/api/v1/integrations/connections/{connection.pk}/inbound/rotate-secret/", {}, format="json"
    )
    new_secret = resp.json()["secret"]
    assert _post_inbound(path, old_secret, CONTACT_EVENT, event_id="old").status_code == 202
    assert (
        _post_inbound(
            path, new_secret, {**CONTACT_EVENT, "data": {**CONTACT_EVENT["data"], "id": "ext-2"}}, event_id="new"
        ).status_code
        == 202
    )
    with tenant_context(org_a.org.pk):
        type(connection).objects.filter(pk=connection.pk).update(
            inbound_previous_secret_expires_at=timezone.now() - timedelta(seconds=1)
        )
    assert _post_inbound(path, old_secret, CONTACT_EVENT, event_id="late").status_code == 401


def test_inbound_key_is_stored_hashed(org_a, inbound):
    path, _, connection = inbound
    key = path.rstrip("/").rsplit("/", 1)[1]
    with tenant_context(org_a.org.pk):
        connection.refresh_from_db()
    assert connection.inbound_key_hash == hashlib.sha256(key.encode()).hexdigest()
    assert key not in json.dumps(
        {f.attname: str(getattr(connection, f.attname)) for f in connection._meta.concrete_fields}
    )


def test_inbound_for_org_a_cannot_touch_org_b(org_a, org_b, crm, inbound):
    """A mapping row pointing at another tenant's record id is never followed (tenant scope + RLS)."""
    path, secret, connection = inbound
    foreign = crm.make_contact(org_b, first_name="Bob", email="bob@example.com")
    with tenant_context(org_a.org.pk):
        IntegrationRecordMap.objects.create(
            connection=connection, entity_type="contact", crm_record_id=foreign.pk, external_record_id="ext-forged"
        )
    payload = {
        "type": "contact.upsert",
        "data": {"id": "ext-forged", "firstName": "Hacked", "emailAddress": "bob@example.com"},
    }
    assert _post_inbound(path, secret, payload, event_id="forged").status_code == 202
    with tenant_context(org_b.org.pk):
        foreign.refresh_from_db()
    assert foreign.first_name == "Bob"
    with tenant_context(org_a.org.pk):
        event = InboundEvent.objects.get(event_id="forged")
    assert event.status == InboundEvent.Status.FAILED and event.error_code == "not_visible"
