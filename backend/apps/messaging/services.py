"""Email and WhatsApp services: OAuth connections, sending (always through a Celery task), syncing.

Rules that hold everywhere:
- A member sends email only from their own connected mailbox; WhatsApp goes through the organization's
  Cloud API account. Sending needs ``email.send`` / ``whatsapp.send``; linked records must be viewable.
- Provider tokens are decrypted only inside the task that uses them; the API never returns them.
- Template WhatsApp messages need the contact's recorded opt-in; free-form text needs an inbound
  message in the last 24 hours (the platform's customer-service window).
- Every send, failure, connection and disconnection is audited (never the token or the body).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import secrets
import uuid
from base64 import urlsafe_b64encode
from typing import Any

import structlog
from django.conf import settings
from django.core.cache import cache
from django.core.validators import EmailValidator
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check, scope
from apps.core import crypto, validators
from apps.core.exceptions import DomainError
from apps.core.tenancy.context import tenant_atomic
from apps.messaging import providers
from apps.messaging.models import (
    ConnectionStatus,
    EmailAccount,
    EmailAttachment,
    EmailMessage,
    EmailProvider,
    EmailTemplate,
    MessageDirection,
    WhatsAppAccount,
    WhatsAppMessage,
    WhatsAppTemplate,
)
from apps.messaging.providers.base import OutgoingEmail, OutgoingWhatsApp, ProviderError

log = structlog.get_logger(__name__)

MAX_RECIPIENTS = 20
MAX_BODY = 50_000
MAX_ATTACHMENTS = 5
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
ALLOWED_ATTACHMENT_TYPES = frozenset(
    {
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/gif",
        "text/plain",
        "text/csv",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
)
OAUTH_STATE_TTL = 10 * 60
TOKEN_REFRESH_MARGIN = dt.timedelta(minutes=3)
WHATSAPP_WINDOW = dt.timedelta(hours=24)
_DIGITS = re.compile(r"\D+")
_email_validator = EmailValidator(message="Enter a valid email address.")


# ----------------------------------------------------------------------------- helpers


def _clean_addresses(values: Any, *, field: str) -> list[str]:
    if values in (None, ""):
        return []
    if isinstance(values, str):
        values = [v for v in re.split(r"[,;\s]+", values) if v]
    if not isinstance(values, list):
        raise ValidationError({field: "Expected a list of email addresses."})
    out: list[str] = []
    for raw in values:
        addr = validators.clean_text(str(raw), max_length=254).lower()
        if not addr:
            continue
        try:
            _email_validator(addr)
        except Exception as exc:
            raise ValidationError({field: f"'{addr}' is not a valid email address."}) from exc
        if addr not in out:
            out.append(addr)
    if len(out) > MAX_RECIPIENTS:
        raise ValidationError({field: f"At most {MAX_RECIPIENTS} recipients."})
    return out


def normalise_phone(value: str) -> str:
    digits = _DIGITS.sub("", value or "")
    if not 8 <= len(digits) <= 15:
        raise ValidationError({"phone": "The contact needs a phone number in international format."})
    return digits


def _linked(actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
    """Resolve contact/company/deal ids inside the actor's view scope; fill company from contact/deal."""
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal

    out: dict[str, Any] = {"contact": None, "company": None, "deal": None}
    for key, module, model in (
        ("contact", "contacts", Contact),
        ("company", "companies", Company),
        ("deal", "deals", Deal),
    ):
        raw = data.get(f"{key}_id")
        if not raw:
            continue
        try:
            pk = uuid.UUID(str(raw))
        except ValueError as exc:
            raise ValidationError({f"{key}_id": "Expected a UUID."}) from exc
        obj = scope(actor, f"{module}.view", model.objects.filter(pk=pk, archived_at__isnull=True)).first()
        if obj is None:
            raise ValidationError({f"{key}_id": "Record not found."})
        out[key] = obj
    if out["company"] is None and out["contact"] is not None and out["contact"].company_id:
        out["company"] = out["contact"].company
    if out["company"] is None and out["deal"] is not None and out["deal"].company_id:
        out["company"] = out["deal"].company
    if out["contact"] is None and out["deal"] is not None and out["deal"].primary_contact_id:
        out["contact"] = out["deal"].primary_contact
    return out


def touch_last_activity(*, contact=None, company=None, deal=None, when: dt.datetime) -> None:
    """A sent or received message counts as activity on the linked records."""
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal

    for model, obj in ((Contact, contact), (Company, company), (Deal, deal)):
        if obj is None:
            continue
        model.objects.filter(pk=obj.pk).filter(Q(last_activity_at__isnull=True) | Q(last_activity_at__lt=when)).update(
            last_activity_at=when
        )


def render_template(text: str, *, contact=None, company=None, deal=None, sender=None) -> str:
    """Substitute ``{{first_name}}``-style placeholders. Unknown placeholders are left blank."""
    values = {
        "first_name": getattr(contact, "first_name", "") or "",
        "last_name": getattr(contact, "last_name", "") or "",
        "full_name": getattr(contact, "display_name", "") or "",
        "company": getattr(company, "name", "") or (getattr(getattr(contact, "company", None), "name", "") or ""),
        "deal_name": getattr(deal, "name", "") or "",
        "owner_name": getattr(getattr(sender, "user", None), "display_name", "") or "",
    }

    def sub(match: re.Match[str]) -> str:
        return values.get(match.group(1).strip().lower(), "")

    return re.sub(r"\{\{\s*([a-z_]+)\s*\}\}", sub, text or "")


# ----------------------------------------------------------------------------- email accounts


def _redirect_uri() -> str:
    return f"{settings.FRONTEND_ORIGIN}/api/v1/email/accounts/callback/"


def start_oauth(actor: Actor, provider: str, *, request: Any = None) -> str:
    check(actor, "email.connect")
    if provider not in EmailProvider.values:
        raise ValidationError({"provider": "Choose gmail or microsoft."})
    if not providers.email_provider_configured(provider):
        raise DomainError(
            "This email provider is not configured for the workspace yet. Ask an administrator.",
            code="provider_not_configured",
            status_code=409,
        )
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    cache.set(
        f"oauth:email:{state}",
        {
            "membership_id": str(actor.membership.pk),
            "organization_id": str(actor.organization.pk),
            "provider": provider,
            "verifier": verifier,
        },
        OAUTH_STATE_TTL,
    )
    audit.record("email.connect_started", request=request, user=actor.user, metadata={"provider": provider})
    return providers.email_provider(provider).authorization_url(
        state=state, redirect_uri=_redirect_uri(), code_challenge=challenge
    )


@transaction.atomic
def complete_oauth(actor: Actor, *, state: str, code: str, request: Any = None) -> EmailAccount:
    check(actor, "email.connect")
    key = f"oauth:email:{state}"
    pending = cache.get(key) if state and len(state) <= 128 else None
    if (
        not pending
        or pending.get("membership_id") != str(actor.membership.pk)
        or pending.get("organization_id") != str(actor.organization.pk)
    ):
        raise DomainError("This sign-in link is invalid or has expired. Start again.", code="oauth_state_invalid")
    cache.delete(key)
    provider = pending["provider"]
    try:
        tokens = providers.email_provider(provider).exchange_code(
            code=code, redirect_uri=_redirect_uri(), code_verifier=pending["verifier"]
        )
    except ProviderError as exc:
        raise DomainError(
            f"Could not connect the mailbox: {exc.message}", code="oauth_failed", status_code=502
        ) from exc
    if not tokens.email_address:
        raise DomainError("The provider did not return a mailbox address.", code="oauth_failed", status_code=502)
    now = timezone.now()
    EmailAccount.objects.filter(
        membership=actor.membership, status__in=[ConnectionStatus.CONNECTED, ConnectionStatus.ERROR]
    ).update(
        status=ConnectionStatus.DISCONNECTED,
        disconnected_at=now,
        access_token_enc="",  # nosec B106 - empty means no stored token
        refresh_token_enc="",
        updated_at=now,
    )
    account = EmailAccount.objects.create(
        membership=actor.membership,
        provider=provider,
        email_address=tokens.email_address.lower(),
        display_name=tokens.display_name[:120],
        access_token_enc=crypto.encrypt(tokens.access_token),
        refresh_token_enc=crypto.encrypt(tokens.refresh_token),
        token_expires_at=tokens.expires_at,
        scopes=tokens.scopes[:20],
        connected_at=now,
        last_sync_at=now,
    )
    audit.record(
        "email.account_connected",
        request=request,
        user=actor.user,
        resource=account,
        resource_type="email_account",
        metadata={"provider": provider, "email_address": account.email_address},
    )
    return account


@transaction.atomic
def disconnect_account(actor: Actor, account: EmailAccount, *, request: Any = None) -> EmailAccount:
    check(actor, "email.connect", account)
    if account.status == ConnectionStatus.DISCONNECTED:
        return account
    account.status = ConnectionStatus.DISCONNECTED
    account.disconnected_at = timezone.now()
    account.access_token_enc = ""  # nosec B105 - empty means no stored token
    account.refresh_token_enc = ""  # nosec B105 - empty means no stored token
    account.save(update_fields=["status", "disconnected_at", "access_token_enc", "refresh_token_enc", "updated_at"])
    audit.record(
        "email.account_disconnected",
        request=request,
        user=actor.user,
        resource=account,
        resource_type="email_account",
        metadata={"provider": account.provider},
    )
    return account


def usable_account(membership_id: uuid.UUID) -> EmailAccount | None:
    return (
        EmailAccount.objects.filter(
            membership_id=membership_id, status__in=[ConnectionStatus.CONNECTED, ConnectionStatus.ERROR]
        )
        .exclude(refresh_token_enc="")  # nosec B106 - empty means no stored token
        .first()
    )


def access_token_for(account: EmailAccount) -> str:
    """Decrypt the access token, refreshing it first when it is about to expire."""
    now = timezone.now()
    if account.token_expires_at is None or account.token_expires_at <= now + TOKEN_REFRESH_MARGIN:
        refresh = crypto.decrypt(account.refresh_token_enc)
        tokens = providers.email_provider(account.provider).refresh(refresh)
        account.access_token_enc = crypto.encrypt(tokens.access_token)
        if tokens.refresh_token:
            account.refresh_token_enc = crypto.encrypt(tokens.refresh_token)
        account.token_expires_at = tokens.expires_at
        account.save(update_fields=["access_token_enc", "refresh_token_enc", "token_expires_at", "updated_at"])
    return crypto.decrypt(account.access_token_enc)


def mark_account_error(account: EmailAccount, message: str) -> None:
    EmailAccount.objects.filter(pk=account.pk).update(
        status=ConnectionStatus.ERROR, error_message=message[:255], updated_at=timezone.now()
    )


# ----------------------------------------------------------------------------- email templates


@transaction.atomic
def create_template(
    actor: Actor, *, name: str, subject: str, body: str, is_shared: bool = True, request: Any = None
) -> EmailTemplate:
    check(actor, "email.templates_manage")
    name = validators.clean_text(name, max_length=80)
    if not name:
        raise ValidationError({"name": "Name is required."})
    if EmailTemplate.objects.filter(name__iexact=name).exists():
        raise DomainError("A template with this name already exists.", code="template_name_taken", status_code=409)
    template = EmailTemplate.objects.create(
        name=name,
        subject=validators.clean_text(subject, max_length=255),
        body=validators.clean_text(body, max_length=MAX_BODY, allow_newlines=True),
        is_shared=bool(is_shared),
        created_by=actor.membership,
    )
    audit.record("email.template_created", request=request, user=actor.user, resource=template, metadata={"name": name})
    return template


@transaction.atomic
def update_template(actor: Actor, template: EmailTemplate, *, request: Any = None, **changes: Any) -> EmailTemplate:
    check(actor, "email.templates_manage", template)
    changed: list[str] = []
    if changes.get("name") is not None:
        name = validators.clean_text(changes["name"], max_length=80)
        if not name:
            raise ValidationError({"name": "Name is required."})
        if name.lower() != template.name.lower() and EmailTemplate.objects.filter(name__iexact=name).exists():
            raise DomainError("A template with this name already exists.", code="template_name_taken", status_code=409)
        template.name = name
        changed.append("name")
    if changes.get("subject") is not None:
        template.subject = validators.clean_text(changes["subject"], max_length=255)
        changed.append("subject")
    if changes.get("body") is not None:
        template.body = validators.clean_text(changes["body"], max_length=MAX_BODY, allow_newlines=True)
        changed.append("body")
    if changes.get("is_shared") is not None:
        template.is_shared = bool(changes["is_shared"])
        changed.append("is_shared")
    if changed:
        template.save(update_fields=[*changed, "updated_at"])
        audit.record(
            "email.template_updated", request=request, user=actor.user, resource=template, metadata={"fields": changed}
        )
    return template


@transaction.atomic
def delete_template(actor: Actor, template: EmailTemplate, *, request: Any = None) -> None:
    check(actor, "email.templates_manage", template)
    template_id, name = template.pk, template.name
    template.delete()
    audit.record(
        "email.template_deleted",
        request=request,
        user=actor.user,
        resource_type="emailtemplate",
        resource_id=template_id,
        metadata={"name": name},
    )


# ----------------------------------------------------------------------------- sending email


@transaction.atomic
def send_email(
    actor: Actor, data: dict[str, Any], *, attachments: list[tuple[str, str, bytes]] | None = None, request: Any = None
) -> EmailMessage:
    check(actor, "email.send")
    account = usable_account(actor.membership.pk)
    if account is None:
        raise DomainError(
            "Connect your Gmail or Microsoft 365 mailbox in Settings before sending email.",
            code="email_not_connected",
            status_code=409,
        )
    to = _clean_addresses(data.get("to"), field="to")
    if not to:
        raise ValidationError({"to": "Add at least one recipient."})
    cc = _clean_addresses(data.get("cc"), field="cc")
    bcc = _clean_addresses(data.get("bcc"), field="bcc")
    subject = validators.clean_text(data.get("subject"), max_length=255)
    body = validators.clean_text(data.get("body"), max_length=MAX_BODY, allow_newlines=True)
    if not body:
        raise ValidationError({"body": "Write a message."})
    linked = _linked(actor, data)
    template = None
    if data.get("template_id"):
        template = EmailTemplate.objects.filter(pk=data["template_id"]).first()
        if template is None:
            raise ValidationError({"template_id": "Unknown template."})
    reply_to = None
    if data.get("in_reply_to_id"):
        reply_to = EmailMessage.objects.filter(pk=data["in_reply_to_id"]).first()
        if reply_to is None or not can_view_message(actor, reply_to):
            raise ValidationError({"in_reply_to_id": "Message not found."})
    message = EmailMessage.objects.create(
        account=account,
        direction=MessageDirection.OUTBOUND,
        status=EmailMessage.Status.QUEUED,
        from_address=account.email_address,
        to_addresses=to,
        cc_addresses=cc,
        bcc_addresses=bcc,
        subject=subject,
        body_text=body,
        snippet=body[:300],
        provider_thread_id=reply_to.provider_thread_id if reply_to else "",
        in_reply_to=reply_to.provider_message_id if reply_to else "",
        contact=linked["contact"] or (reply_to.contact if reply_to else None),
        company=linked["company"] or (reply_to.company if reply_to else None),
        deal=linked["deal"] or (reply_to.deal if reply_to else None),
        sent_by=actor.membership,
        ai_assisted=bool(data.get("ai_assisted")),
        template=template,
    )
    for filename, content_type, blob in attachments or []:
        _store_attachment(message, filename, content_type, blob)
    audit.record(
        "email.queued",
        request=request,
        user=actor.user,
        resource=message,
        resource_type="email",
        metadata={
            "recipients": len(to) + len(cc) + len(bcc),
            "contact_id": str(message.contact_id) if message.contact_id else None,
            "deal_id": str(message.deal_id) if message.deal_id else None,
            "ai_assisted": message.ai_assisted,
        },
    )
    from apps.messaging.tasks import send_email_message

    transaction.on_commit(
        lambda: send_email_message.apply_async(
            kwargs={
                "message_id": str(message.pk),
                "organization_id": str(actor.organization.pk),
                "actor_membership_id": str(actor.membership.pk),
            }
        )
    )
    return message


def _store_attachment(message: EmailMessage, filename: str, content_type: str, blob: bytes) -> EmailAttachment:
    from apps.importexport import storage

    if EmailAttachment.objects.filter(message=message).count() >= MAX_ATTACHMENTS:
        raise ValidationError({"attachments": f"At most {MAX_ATTACHMENTS} attachments."})
    if len(blob) > MAX_ATTACHMENT_BYTES:
        raise ValidationError({"attachments": "Attachments are limited to 10 MB each."})
    if content_type not in ALLOWED_ATTACHMENT_TYPES:
        raise ValidationError({"attachments": "This file type is not allowed."})
    safe_name = re.sub(r"[^A-Za-z0-9._ -]+", "_", filename or "attachment")[:255] or "attachment"
    key = storage.new_key(message.organization_id, "email")
    storage.write(key, blob)
    return EmailAttachment.objects.create(
        message=message, filename=safe_name, content_type=content_type, size_bytes=len(blob), storage_key=key
    )


# ----------------------------------------------------------------------------- idempotent delivery
#
# One logical send must reach the customer at most once, whatever Celery, the network or the
# database do. The order of commits is the whole design:
#
#   1. CLAIM      QUEUED -> SENDING in a single conditional UPDATE, committed before anything else.
#                 A redelivered task, a second worker, or a retry after a timeout all run the same
#                 UPDATE and match zero rows, so exactly one caller ever proceeds to step 2.
#   2. MARK       record ``provider_attempted_at`` and commit. From here on the honest answer to
#                 "did this send go out?" is "maybe", so recovery reconciles and never resends.
#   3. SEND       call the provider with no transaction open, carrying the idempotency key.
#   4. SETTLE     SENDING -> SENT (or FAILED) and commit.
#
# A crash between 2 and 4 leaves a SENDING row for ``reconcile_stuck_sends``: it asks a provider
# that can look a send up by key, and otherwise settles on UNCONFIRMED rather than risk a duplicate.
# A crash between 1 and 2 leaves ``provider_attempted_at`` NULL, which is provably "never sent", so
# that one is safely returned to QUEUED.
#
# Every step runs in ``tenant_atomic()``: these tasks are ``atomic=False`` because they must commit
# as they go, so each transaction re-applies the RLS context it needs.


def claim_email(message_id: uuid.UUID, *, actor_membership_id: uuid.UUID) -> EmailMessage | None:
    """Take exclusive ownership of a queued send. None when someone else already owns it."""
    now = timezone.now()
    with tenant_atomic():
        claimed = EmailMessage.objects.filter(
            pk=message_id, status=EmailMessage.Status.QUEUED, sent_by_id=actor_membership_id
        ).update(
            status=EmailMessage.Status.SENDING,
            claimed_at=now,
            send_attempts=F("send_attempts") + 1,
            updated_at=now,
        )
        if not claimed:
            return None
        return (
            EmailMessage.objects.select_related("account", "contact", "company", "deal").filter(pk=message_id).first()
        )


def deliver_email(message: EmailMessage) -> str:
    """Send a claimed message through the provider and settle it. Never raises to the worker."""
    from apps.importexport import storage

    account = message.account
    if account is None or not account.is_usable:
        _fail_email(message, "The mailbox is no longer connected.")
        return "failed"
    try:
        with tenant_atomic():
            blobs = [(a.filename, a.content_type, storage.read(a.storage_key)) for a in message.attachments.all()]
        token = access_token_for(account)
    except crypto.DecryptionError:
        mark_account_error(account, "Reconnect your mailbox.")
        _fail_email(message, "Stored credentials could not be read.")
        return "failed"
    except ProviderError as exc:
        if exc.status in {401, 403}:
            mark_account_error(account, "Reconnect your mailbox: the provider rejected the credentials.")
        _fail_email(message, exc.message)
        return "failed"

    # Commit "we are about to call the provider" before calling it. Everything past this point is
    # recoverable only by reconciliation.
    with tenant_atomic():
        now = timezone.now()
        EmailMessage.objects.filter(pk=message.pk).update(provider_attempted_at=now, updated_at=now)
    try:
        result = providers.email_provider(account.provider).send(
            token,
            OutgoingEmail(
                from_address=message.from_address,
                to=list(message.to_addresses),
                cc=list(message.cc_addresses),
                bcc=list(message.bcc_addresses),
                subject=message.subject,
                body_text=message.body_text,
                in_reply_to=message.in_reply_to,
                thread_id=message.provider_thread_id,
                attachments=blobs,
                idempotency_key=str(message.idempotency_key),
            ),
        )
    except ProviderError as exc:
        if exc.status in {401, 403}:
            mark_account_error(account, "Reconnect your mailbox: the provider rejected the credentials.")
        _fail_email(message, exc.message)
        return "failed"
    except crypto.DecryptionError:
        mark_account_error(account, "Reconnect your mailbox.")
        _fail_email(message, "Stored credentials could not be read.")
        return "failed"
    settle_email_sent(message, result)
    return "sent"


def settle_email_sent(message: EmailMessage, result) -> None:
    """Record a provider success. Guarded on the in-flight states so it is safe to replay."""
    from apps.importexport import storage

    now = timezone.now()
    with tenant_atomic():
        EmailMessage.objects.filter(
            pk=message.pk, status__in=[EmailMessage.Status.SENDING, EmailMessage.Status.UNCONFIRMED]
        ).update(
            status=EmailMessage.Status.SENT,
            sent_at=now,
            provider_message_id=result.provider_message_id[:255],
            provider_thread_id=(result.provider_thread_id or message.provider_thread_id)[:255],
            error_message="",
            updated_at=now,
        )
        touch_last_activity(contact=message.contact, company=message.company, deal=message.deal, when=now)
        audit.record(
            "email.sent",
            organization_id=message.organization_id,
            resource=message,
            resource_type="email",
            metadata={
                "provider": message.account.provider if message.account else "",
                "recipients": len(message.to_addresses),
                "attempt": message.send_attempts,
            },
        )
        attachments = list(message.attachments.all())
    for a in attachments:
        storage.delete(a.storage_key)


def _fail_email(message: EmailMessage, reason: str) -> None:
    """Settle a claimed send as failed. Only a SENDING row is settled, so a late failure from a
    superseded attempt can never overwrite a success recorded by the attempt that owns the row."""
    with tenant_atomic():
        EmailMessage.objects.filter(pk=message.pk, status=EmailMessage.Status.SENDING).update(
            status=EmailMessage.Status.FAILED, error_message=reason[:255], updated_at=timezone.now()
        )
        audit.record(
            "email.failed",
            organization_id=message.organization_id,
            resource=message,
            resource_type="email",
            metadata={"reason": reason[:255], "attempt": message.send_attempts},
        )


def can_view_message(actor: Actor, message: Any) -> bool:
    """A message is visible when the actor may view a linked record, or they sent it."""
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal

    if getattr(message, "sent_by_id", None) == actor.membership.pk:
        return True
    for key, module, model in (
        ("contact_id", "contacts", Contact),
        ("deal_id", "deals", Deal),
        ("company_id", "companies", Company),
    ):
        pk = getattr(message, key, None)
        if pk and scope(actor, f"{module}.view", model.objects.filter(pk=pk)).exists():
            return True
    return False


# ----------------------------------------------------------------------------- email sync (inbound)


def sync_account(account: EmailAccount, *, now: dt.datetime | None = None) -> int:
    """Pull recent inbox messages from contacts and record them as inbound emails. Returns the count."""
    from apps.contacts.models import Contact
    from apps.notifications import service as notifications

    now = now or timezone.now()
    since = (account.last_sync_at or now - dt.timedelta(days=1)) - dt.timedelta(hours=1)
    try:
        token = access_token_for(account)
        incoming, cursor = providers.email_provider(account.provider).fetch_recent(
            token, since=since, cursor=account.sync_cursor
        )
    except (ProviderError, crypto.DecryptionError) as exc:
        mark_account_error(account, getattr(exc, "message", "Reconnect your mailbox."))
        return 0
    created = 0
    addresses = {m.from_address for m in incoming if m.from_address and m.from_address != account.email_address}
    contacts = {
        c.email: c
        for c in Contact.objects.filter(email__in=list(addresses)[:200], archived_at__isnull=True).select_related(
            "company"
        )
    }
    for item in incoming:
        contact = contacts.get(item.from_address)
        if contact is None or not item.provider_message_id:
            continue
        if EmailMessage.objects.filter(account=account, provider_message_id=item.provider_message_id).exists():
            continue
        thread = (
            EmailMessage.objects.filter(provider_thread_id=item.provider_thread_id, direction=MessageDirection.OUTBOUND)
            .exclude(provider_thread_id="")
            .order_by("-created_at")
            .first()
            if item.provider_thread_id
            else None
        )
        message = EmailMessage.objects.create(
            account=account,
            direction=MessageDirection.INBOUND,
            status=EmailMessage.Status.RECEIVED,
            from_address=item.from_address,
            to_addresses=item.to[:MAX_RECIPIENTS],
            subject=item.subject,
            body_text=item.body_text,
            snippet=item.body_text[:300],
            provider_message_id=item.provider_message_id[:255],
            provider_thread_id=item.provider_thread_id[:255],
            in_reply_to=item.in_reply_to[:255],
            contact=contact,
            company=contact.company if contact.company_id else (thread.company if thread else None),
            deal=thread.deal if thread else None,
            received_at=item.received_at,
        )
        created += 1
        touch_last_activity(contact=contact, company=message.company, deal=message.deal, when=item.received_at)
        recipient = thread.sent_by_id if thread and thread.sent_by_id else (account.membership_id)
        notifications.notify(
            recipient,
            kind="customer_replied",
            title=f"{contact.display_name} replied by email",
            body=(item.subject or item.body_text)[:200],
            entity_type="contact",
            entity_id=contact.pk,
        )
    EmailAccount.objects.filter(pk=account.pk).update(
        last_sync_at=now, sync_cursor=(cursor or "")[:512], updated_at=now
    )
    return created


# ----------------------------------------------------------------------------- whatsapp account


@transaction.atomic
def connect_whatsapp(
    actor: Actor, *, phone_number_id: str, access_token: str, business_account_id: str = "", request: Any = None
) -> WhatsAppAccount:
    check(actor, "whatsapp.manage")
    phone_number_id = validators.clean_text(phone_number_id, max_length=64)
    business_account_id = validators.clean_text(business_account_id, max_length=64)
    access_token = (access_token or "").strip()
    if not phone_number_id or not re.fullmatch(r"[0-9]{5,64}", phone_number_id):
        raise ValidationError({"phone_number_id": "Enter the numeric phone number id from Meta Business Manager."})
    if not access_token or len(access_token) > 4096:
        raise ValidationError({"access_token": "Enter the system user access token."})  # nosec B105 - message text, not a secret
    try:
        info = providers.whatsapp_provider().verify_account(access_token, phone_number_id)
    except ProviderError as exc:
        raise DomainError(
            f"WhatsApp rejected the credentials: {exc.message}", code="whatsapp_verify_failed", status_code=502
        ) from exc
    now = timezone.now()
    account, _ = WhatsAppAccount.objects.update_or_create(
        organization_id=actor.organization.pk,
        defaults={
            "phone_number_id": phone_number_id,
            "business_account_id": business_account_id,
            "display_phone": str(info.get("display_phone_number", ""))[:32],
            "display_name": str(info.get("verified_name", ""))[:120],
            "access_token_enc": crypto.encrypt(access_token),
            "status": ConnectionStatus.CONNECTED,
            "error_message": "",
            "connected_by": actor.membership,
            "connected_at": now,
        },
    )
    audit.record(
        "whatsapp.account_connected",
        request=request,
        user=actor.user,
        resource=account,
        resource_type="whatsapp_account",
        metadata={"phone_number_id": phone_number_id},
    )
    return account


@transaction.atomic
def disconnect_whatsapp(actor: Actor, *, request: Any = None) -> None:
    check(actor, "whatsapp.manage")
    account = WhatsAppAccount.objects.first()
    if account is None:
        return
    account.status = ConnectionStatus.DISCONNECTED
    account.access_token_enc = ""  # nosec B105 - empty means no stored token
    account.save(update_fields=["status", "access_token_enc", "updated_at"])
    audit.record(
        "whatsapp.account_disconnected",
        request=request,
        user=actor.user,
        resource=account,
        resource_type="whatsapp_account",
    )


def whatsapp_account() -> WhatsAppAccount | None:
    return WhatsAppAccount.objects.filter(status=ConnectionStatus.CONNECTED).exclude(access_token_enc="").first()  # nosec B106 - empty means no stored token


@transaction.atomic
def upsert_whatsapp_template(
    actor: Actor, *, name: str, language: str = "en", category: str = "", body: str = "", request: Any = None
) -> WhatsAppTemplate:
    check(actor, "whatsapp.manage")
    name = validators.clean_text(name, max_length=120)
    if not re.fullmatch(r"[a-z0-9_]{1,120}", name):
        raise ValidationError(
            {"name": "Template names use lowercase letters, digits and underscores (as approved by Meta)."}
        )
    language = validators.clean_text(language, max_length=16) or "en"
    body = validators.clean_text(body, max_length=2000, allow_newlines=True)
    params = len(set(re.findall(r"\{\{\s*(\d+)\s*\}\}", body)))
    template, created = WhatsAppTemplate.objects.update_or_create(
        organization_id=actor.organization.pk,
        name=name,
        language=language,
        defaults={"category": validators.clean_text(category, max_length=32), "body": body, "parameter_count": params},
    )
    audit.record(
        "whatsapp.template_created" if created else "whatsapp.template_updated",
        request=request,
        user=actor.user,
        resource=template,
        resource_type="whatsapp_template",
        metadata={"name": name, "language": language},
    )
    return template


@transaction.atomic
def delete_whatsapp_template(actor: Actor, template: WhatsAppTemplate, *, request: Any = None) -> None:
    check(actor, "whatsapp.manage", template)
    template_id, name = template.pk, template.name
    template.delete()
    audit.record(
        "whatsapp.template_deleted",
        request=request,
        user=actor.user,
        resource_type="whatsapptemplate",
        resource_id=template_id,
        metadata={"name": name},
    )


# ----------------------------------------------------------------------------- sending whatsapp


def _fill_placeholder(body: str, index: int, value: str) -> str:
    return re.sub(r"\{\{\s*" + str(index) + r"\s*\}\}", lambda _m: value, body)


def within_service_window(wa_id: str, *, now: dt.datetime | None = None) -> bool:
    now = now or timezone.now()
    return WhatsAppMessage.objects.filter(
        wa_id=wa_id, direction=MessageDirection.INBOUND, received_at__gte=now - WHATSAPP_WINDOW
    ).exists()


@transaction.atomic
def send_whatsapp(actor: Actor, data: dict[str, Any], *, request: Any = None) -> WhatsAppMessage:
    check(actor, "whatsapp.send")
    account = whatsapp_account()
    if account is None:
        raise DomainError(
            "WhatsApp is not connected for this workspace. An administrator can connect it in Settings.",
            code="whatsapp_not_connected",
            status_code=409,
        )
    linked = _linked(actor, data)
    contact = linked["contact"]
    if contact is None:
        raise ValidationError({"contact_id": "Choose the contact to message."})
    wa_id = normalise_phone(contact.phone)
    message_type = data.get("message_type") or ("template" if data.get("template_id") else "text")
    template = None
    params: list[str] = []
    body = ""
    if message_type == "template":
        template_id = data.get("template_id")
        template = WhatsAppTemplate.objects.filter(pk=template_id).first() if template_id else None
        if template is None:
            raise ValidationError({"template_id": "Choose an approved template."})
        if not contact.whatsapp_opt_in:
            raise DomainError(
                "This contact has not opted in to WhatsApp messages. Record their consent on the contact first.",
                code="whatsapp_consent_required",
                status_code=409,
            )
        raw_params = data.get("template_params") or []
        if not isinstance(raw_params, list) or len(raw_params) != template.parameter_count:
            raise ValidationError({"template_params": f"This template needs {template.parameter_count} value(s)."})
        params = [validators.clean_text(str(p), max_length=200) for p in raw_params]
        body = template.body
        for i, p in enumerate(params, start=1):
            body = _fill_placeholder(body, i, p)
    elif message_type == "text":
        body = validators.clean_text(data.get("body"), max_length=4096, allow_newlines=True)
        if not body:
            raise ValidationError({"body": "Write a message."})
        if not within_service_window(wa_id):
            raise DomainError(
                "Free-form messages can only be sent within 24 hours of the customer's last message. "
                "Use an approved template instead.",
                code="whatsapp_window_closed",
                status_code=409,
            )
    else:
        raise ValidationError({"message_type": "Choose text or template."})
    message = WhatsAppMessage.objects.create(
        account=account,
        direction=MessageDirection.OUTBOUND,
        status=WhatsAppMessage.Status.QUEUED,
        wa_id=wa_id,
        message_type=message_type,
        body=body,
        template=template,
        template_params=params,
        contact=contact,
        company=linked["company"],
        deal=linked["deal"],
        sent_by=actor.membership,
        ai_assisted=bool(data.get("ai_assisted")),
    )
    audit.record(
        "whatsapp.queued",
        request=request,
        user=actor.user,
        resource=message,
        resource_type="whatsapp",
        metadata={"type": message_type, "template": template.name if template else None, "contact_id": str(contact.pk)},
    )
    from apps.messaging.tasks import send_whatsapp_message

    transaction.on_commit(
        lambda: send_whatsapp_message.apply_async(
            kwargs={
                "message_id": str(message.pk),
                "organization_id": str(actor.organization.pk),
                "actor_membership_id": str(actor.membership.pk),
            }
        )
    )
    return message


def claim_whatsapp(message_id: uuid.UUID, *, actor_membership_id: uuid.UUID) -> WhatsAppMessage | None:
    """Take exclusive ownership of a queued send. None when someone else already owns it."""
    now = timezone.now()
    with tenant_atomic():
        claimed = WhatsAppMessage.objects.filter(
            pk=message_id, status=WhatsAppMessage.Status.QUEUED, sent_by_id=actor_membership_id
        ).update(
            status=WhatsAppMessage.Status.SENDING,
            claimed_at=now,
            send_attempts=F("send_attempts") + 1,
            updated_at=now,
        )
        if not claimed:
            return None
        return (
            WhatsAppMessage.objects.select_related("account", "template", "contact", "company", "deal")
            .filter(pk=message_id)
            .first()
        )


def deliver_whatsapp(message: WhatsAppMessage) -> str:
    """Same four-step contract as email. The Cloud API cannot de-duplicate or look a send up by our
    key, so a lost result here always ends as UNCONFIRMED rather than being replayed."""
    account = message.account
    if account is None or account.status != ConnectionStatus.CONNECTED:
        _fail_whatsapp(message, "WhatsApp is no longer connected.")
        return "failed"
    try:
        token = crypto.decrypt(account.access_token_enc)
    except crypto.DecryptionError:
        _fail_whatsapp(message, "Stored credentials could not be read.")
        return "failed"
    with tenant_atomic():
        now = timezone.now()
        WhatsAppMessage.objects.filter(pk=message.pk).update(provider_attempted_at=now, updated_at=now)
    try:
        provider_id = providers.whatsapp_provider().send(
            token,
            account.phone_number_id,
            OutgoingWhatsApp(
                to=message.wa_id,
                body=message.body if message.message_type == "text" else "",
                template_name=message.template.name if message.template_id and message.template else "",
                template_language=message.template.language if message.template_id and message.template else "en",
                template_params=list(message.template_params),
                idempotency_key=str(message.idempotency_key),
            ),
        )
    except (ProviderError, crypto.DecryptionError) as exc:
        _fail_whatsapp(message, getattr(exc, "message", "Could not send the message."))
        return "failed"
    settle_whatsapp_sent(message, provider_id)
    return "sent"


def settle_whatsapp_sent(message: WhatsAppMessage, provider_id: str) -> None:
    now = timezone.now()
    with tenant_atomic():
        WhatsAppMessage.objects.filter(
            pk=message.pk, status__in=[WhatsAppMessage.Status.SENDING, WhatsAppMessage.Status.UNCONFIRMED]
        ).update(
            status=WhatsAppMessage.Status.SENT,
            sent_at=now,
            provider_message_id=provider_id[:255],
            error_message="",
            updated_at=now,
        )
        touch_last_activity(contact=message.contact, company=message.company, deal=message.deal, when=now)
        audit.record(
            "whatsapp.sent",
            organization_id=message.organization_id,
            resource=message,
            resource_type="whatsapp",
            metadata={"type": message.message_type, "attempt": message.send_attempts},
        )


def _fail_whatsapp(message: WhatsAppMessage, reason: str) -> None:
    with tenant_atomic():
        WhatsAppMessage.objects.filter(pk=message.pk, status=WhatsAppMessage.Status.SENDING).update(
            status=WhatsAppMessage.Status.FAILED, error_message=reason[:255], updated_at=timezone.now()
        )
        audit.record(
            "whatsapp.failed",
            organization_id=message.organization_id,
            resource=message,
            resource_type="whatsapp",
            metadata={"reason": reason[:255], "attempt": message.send_attempts},
        )


# ----------------------------------------------------------------------------- crash reconciliation


def reconcile_email(message: EmailMessage) -> str:
    """Decide what really happened to one send that was claimed and never settled.

    ``provider_attempted_at`` is NULL  -> the provider was never called. Provably not sent, so the
                                         message goes back to QUEUED for a normal retry.
    the provider can look a send up    -> ask it. Found means SENT (with the real identifiers);
                                         not found means it never left, so QUEUED again.
    otherwise                          -> UNCONFIRMED. Never resent: a duplicate message to a
                                         customer is worse than a status someone has to close out.
    """
    account = message.account
    if message.provider_attempted_at is None:
        return _requeue_email(message, "the provider was never called")
    if account is not None and account.is_usable:
        adapter = providers.email_provider(account.provider)
        if getattr(adapter, "capabilities", None) is not None and adapter.capabilities.lookup_by_key:
            try:
                found = adapter.find_sent(access_token_for(account), str(message.idempotency_key))
            except Exception as exc:  # a provider lookup must never break the sweeper
                log.warning("messaging.reconcile_lookup_failed", message_id=str(message.pk), error=str(exc)[:200])
            else:
                if found is not None:
                    settle_email_sent(message, found)
                    _audit_reconciled(message, "email", outcome="sent")
                    return "sent"
                return _requeue_email(message, "the provider has no record of it")
    return _mark_email_unconfirmed(message)


def _requeue_email(message: EmailMessage, reason: str) -> str:
    with tenant_atomic():
        EmailMessage.objects.filter(pk=message.pk, status=EmailMessage.Status.SENDING).update(
            status=EmailMessage.Status.QUEUED, claimed_at=None, provider_attempted_at=None, updated_at=timezone.now()
        )
    _audit_reconciled(message, "email", outcome="requeued", reason=reason)
    return "requeued"


def _mark_email_unconfirmed(message: EmailMessage) -> str:
    with tenant_atomic():
        EmailMessage.objects.filter(pk=message.pk, status=EmailMessage.Status.SENDING).update(
            status=EmailMessage.Status.UNCONFIRMED,
            error_message="The provider accepted this message but the result was lost; it was not sent again.",
            updated_at=timezone.now(),
        )
    _audit_reconciled(message, "email", outcome="unconfirmed")
    return "unconfirmed"


def reconcile_whatsapp(message: WhatsAppMessage) -> str:
    if message.provider_attempted_at is None:
        with tenant_atomic():
            WhatsAppMessage.objects.filter(pk=message.pk, status=WhatsAppMessage.Status.SENDING).update(
                status=WhatsAppMessage.Status.QUEUED,
                claimed_at=None,
                provider_attempted_at=None,
                updated_at=timezone.now(),
            )
        _audit_reconciled(message, "whatsapp", outcome="requeued", reason="the provider was never called")
        return "requeued"
    with tenant_atomic():
        WhatsAppMessage.objects.filter(pk=message.pk, status=WhatsAppMessage.Status.SENDING).update(
            status=WhatsAppMessage.Status.UNCONFIRMED,
            error_message="The provider accepted this message but the result was lost; it was not sent again.",
            updated_at=timezone.now(),
        )
    _audit_reconciled(message, "whatsapp", outcome="unconfirmed")
    return "unconfirmed"


def _audit_reconciled(message: Any, channel: str, *, outcome: str, reason: str = "") -> None:
    with tenant_atomic():
        audit.record(
            f"{channel}.send_reconciled",
            organization_id=message.organization_id,
            resource=message,
            resource_type=channel,
            metadata={"outcome": outcome, "reason": reason, "attempt": message.send_attempts},
        )


def record_inbound_whatsapp(
    account: WhatsAppAccount, *, wa_id: str, provider_message_id: str, body: str, received_at: dt.datetime
) -> WhatsAppMessage | None:
    """Webhook body: store an inbound message inside the account's tenant context and notify the owner."""
    from apps.contacts.models import Contact
    from apps.notifications import service as notifications

    digits = _DIGITS.sub("", wa_id)[:32]
    if not digits or not provider_message_id:
        return None
    if WhatsAppMessage.objects.filter(provider_message_id=provider_message_id).exists():
        return None
    from apps.contacts.phones import phone_digits_expression

    suffix = digits[-10:]
    contact = (
        Contact.objects.filter(archived_at__isnull=True)
        .annotate(phone_digits=phone_digits_expression())
        .filter(phone_digits__endswith=suffix)
        .select_related("company")
        .order_by("-updated_at")
        .first()
    )
    last_outbound = (
        WhatsAppMessage.objects.filter(wa_id=digits, direction=MessageDirection.OUTBOUND)
        .order_by("-created_at")
        .first()
    )
    message = WhatsAppMessage.objects.create(
        account=account,
        direction=MessageDirection.INBOUND,
        status=WhatsAppMessage.Status.RECEIVED,
        wa_id=digits,
        message_type=WhatsAppMessage.Type.TEXT,
        body=validators.clean_text(body, max_length=4096, allow_newlines=True),
        provider_message_id=provider_message_id[:255],
        contact=contact,
        company=contact.company if contact and contact.company_id else None,
        deal=last_outbound.deal if last_outbound else None,
        received_at=received_at,
    )
    touch_last_activity(contact=contact, company=message.company, deal=message.deal, when=received_at)
    recipient = (last_outbound.sent_by_id if last_outbound else None) or (contact.owner_id if contact else None)
    if recipient:
        notifications.notify(
            recipient,
            kind="customer_replied",
            title=f"{contact.display_name if contact else digits} replied on WhatsApp",
            body=message.body[:200],
            entity_type="contact" if contact else "",
            entity_id=contact.pk if contact else None,
        )
    return message


def apply_whatsapp_status(provider_message_id: str, status: str) -> None:
    order = {"sent": 1, "delivered": 2, "read": 3, "failed": 9}
    if status not in order:
        return
    message = WhatsAppMessage.objects.filter(provider_message_id=provider_message_id).first()
    if message is None:
        return
    current = order.get(message.status, 0)
    if status == "failed" or order[status] > current:
        WhatsAppMessage.objects.filter(pk=message.pk).update(status=status, updated_at=timezone.now())
