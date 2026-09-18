"""Messaging background jobs: delivery (tenant-bound, requester rebuilt) and inbox sync (beat)."""

from __future__ import annotations

import uuid

import structlog
from celery import shared_task
from django.conf import settings
from django.utils import timezone

from apps.core.tenancy.context import system_context, tenant_atomic, tenant_context
from apps.core.tenancy.tasks import tenant_task
from apps.messaging import services
from apps.messaging.models import ConnectionStatus, EmailAccount, EmailMessage, WhatsAppMessage

log = structlog.get_logger(__name__)

# A mailbox sync not started before the next beat tick (every 300 s) is superseded by that tick's task:
# dropping it keeps a slow provider from stacking one backlog of syncs on top of the next.
SYNC_FANOUT_EXPIRES_SECONDS = 270

# How many sends one reconciliation pass will settle, per channel. Bounded so the sweeper's own cost
# is predictable no matter how bad an outage was.
RECONCILE_LIMIT = 200


# The send tasks are ``atomic=False`` on purpose: the claim has to be *committed* before the provider
# is called, which is impossible while one transaction wraps the whole task body. See the design note
# above ``services.claim_email``.
@tenant_task(name="messaging.send_email_message", soft_time_limit=60, time_limit=90, ignore_result=True, atomic=False)
def send_email_message(*, message_id: str, organization_id, actor_membership_id: str, **kwargs) -> str:
    message = services.claim_email(uuid.UUID(str(message_id)), actor_membership_id=uuid.UUID(str(actor_membership_id)))
    if message is None:
        # Already claimed, already sent, or not this member's message. A redelivered task lands here.
        return "skipped"
    return services.deliver_email(message)


@tenant_task(
    name="messaging.send_whatsapp_message", soft_time_limit=60, time_limit=90, ignore_result=True, atomic=False
)
def send_whatsapp_message(*, message_id: str, organization_id, actor_membership_id: str, **kwargs) -> str:
    message = services.claim_whatsapp(
        uuid.UUID(str(message_id)), actor_membership_id=uuid.UUID(str(actor_membership_id))
    )
    if message is None:
        return "skipped"
    return services.deliver_whatsapp(message)


@shared_task(name="messaging.reconcile_stuck_sends", ignore_result=True, soft_time_limit=240, time_limit=300)
def reconcile_stuck_sends() -> int:
    """Beat: settle sends whose worker died mid-flight.

    A row sits in SENDING only while one worker owns it. Past ``MESSAGING_SEND_RECONCILE_AFTER`` that
    worker is gone, and the row is the only remaining evidence of what happened. This task turns each
    one into a definite state -- and never into a second message on the wire (see
    ``services.reconcile_email``).
    """
    cutoff = timezone.now() - settings.MESSAGING_SEND_RECONCILE_AFTER
    with system_context("messaging.reconcile_stuck_sends"):
        email_rows = list(
            EmailMessage.all_objects.filter(status=EmailMessage.Status.SENDING, claimed_at__lt=cutoff)
            .order_by("claimed_at")
            .values_list("organization_id", "id")[:RECONCILE_LIMIT]
        )
        whatsapp_rows = list(
            WhatsAppMessage.all_objects.filter(status=WhatsAppMessage.Status.SENDING, claimed_at__lt=cutoff)
            .order_by("claimed_at")
            .values_list("organization_id", "id")[:RECONCILE_LIMIT]
        )
    settled = 0
    for org_id, message_id in email_rows:
        settled += _reconcile_one(org_id, message_id, channel="email")
    for org_id, message_id in whatsapp_rows:
        settled += _reconcile_one(org_id, message_id, channel="whatsapp")
    if settled:
        log.warning("messaging.reconciled_stuck_sends", count=settled)
    return settled


def _reconcile_one(organization_id, message_id, *, channel: str) -> int:
    """Reconcile one message inside its own tenant context, isolating per-message failures.

    Each message is settled in the organization that owns it: the sweep reads ids across tenants, the
    settling never does.
    """
    try:
        with tenant_context(organization_id, reason="task:messaging.reconcile_stuck_sends", apply_db=False):
            if channel == "email":
                with tenant_atomic():
                    email = (
                        EmailMessage.objects.select_related("account")
                        .filter(pk=message_id, status=EmailMessage.Status.SENDING)
                        .first()
                    )
                if email is None:
                    return 0
                services.reconcile_email(email)
            else:
                with tenant_atomic():
                    whatsapp = (
                        WhatsAppMessage.objects.select_related("account")
                        .filter(pk=message_id, status=WhatsAppMessage.Status.SENDING)
                        .first()
                    )
                if whatsapp is None:
                    return 0
                services.reconcile_whatsapp(whatsapp)
    except Exception:
        log.exception("messaging.reconcile_failed", message_id=str(message_id), channel=channel)
        return 0
    return 1


@shared_task(name="messaging.sync_email_accounts", ignore_result=True, soft_time_limit=240, time_limit=300)
def sync_email_accounts() -> int:
    """Beat: fan out one sync task per connected mailbox (each runs in its own tenant context)."""
    with system_context("messaging.sync_email_accounts"):
        rows = list(
            EmailAccount.all_objects.filter(status__in=[ConnectionStatus.CONNECTED, ConnectionStatus.ERROR])
            .exclude(refresh_token_enc="")  # nosec B106 - empty means no stored token
            .values_list("organization_id", "id")[:2000]
        )
    for org_id, account_id in rows:
        sync_email_account.apply_async(
            kwargs={"account_id": str(account_id), "organization_id": str(org_id)},
            expires=SYNC_FANOUT_EXPIRES_SECONDS,
        )
    return len(rows)


@tenant_task(name="messaging.sync_email_account", soft_time_limit=120, time_limit=150, ignore_result=True)
def sync_email_account(*, account_id: str, organization_id, **kwargs) -> int:
    account = EmailAccount.objects.filter(pk=uuid.UUID(str(account_id))).first()
    if account is None or not account.is_usable:
        return 0
    created = services.sync_account(account)
    if created:
        log.info("messaging.synced", account_id=account_id, created=created)
    return created
