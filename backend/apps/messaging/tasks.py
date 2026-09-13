"""Messaging background jobs: delivery (tenant-bound, requester rebuilt) and inbox sync (beat)."""

from __future__ import annotations

import uuid

import structlog
from celery import shared_task

from apps.core.tenancy.context import system_context
from apps.core.tenancy.tasks import tenant_task
from apps.messaging import services
from apps.messaging.models import ConnectionStatus, EmailAccount, EmailMessage, WhatsAppMessage

log = structlog.get_logger(__name__)


@tenant_task(name="messaging.send_email_message", soft_time_limit=60, time_limit=90, ignore_result=True)
def send_email_message(*, message_id: str, organization_id, actor_membership_id: str, **kwargs) -> str:
    message = (
        EmailMessage.objects.select_related("account", "contact", "company", "deal")
        .filter(pk=message_id, status=EmailMessage.Status.QUEUED, sent_by_id=uuid.UUID(str(actor_membership_id)))
        .first()
    )
    if message is None:
        return "skipped"
    services.deliver_email(message)
    return "done"


@tenant_task(name="messaging.send_whatsapp_message", soft_time_limit=60, time_limit=90, ignore_result=True)
def send_whatsapp_message(*, message_id: str, organization_id, actor_membership_id: str, **kwargs) -> str:
    message = (
        WhatsAppMessage.objects.select_related("account", "template", "contact", "company", "deal")
        .filter(pk=message_id, status=WhatsAppMessage.Status.QUEUED, sent_by_id=uuid.UUID(str(actor_membership_id)))
        .first()
    )
    if message is None:
        return "skipped"
    services.deliver_whatsapp(message)
    return "done"


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
        sync_email_account.apply_async(kwargs={"account_id": str(account_id), "organization_id": str(org_id)})
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
