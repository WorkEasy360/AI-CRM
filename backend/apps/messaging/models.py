"""Email (Gmail / Microsoft 365 via OAuth) and WhatsApp (Cloud API) messaging linked to CRM records.

Provider secrets are stored encrypted (``apps.core.crypto``) and never serialized. Messages hang off
contacts/companies/deals so the timeline, AI context and "customer replied" notifications all read the
same rows.
"""

from __future__ import annotations

import uuid
from typing import ClassVar

from django.db import models

from apps.core.models import TenantModel


class EmailProvider(models.TextChoices):
    GMAIL = "gmail", "Gmail"
    MICROSOFT = "microsoft", "Microsoft 365"


class ConnectionStatus(models.TextChoices):
    CONNECTED = "connected", "Connected"
    ERROR = "error", "Needs attention"
    DISCONNECTED = "disconnected", "Disconnected"


class SendState(models.TextChoices):
    """The states an outbound message moves through. Shared by email and WhatsApp.

    QUEUED -> SENDING is a single conditional UPDATE that commits *before* the provider is called,
    so a redelivered Celery task (or a second worker) matches zero rows and sends nothing. SENDING
    carries ``provider_attempted_at``: set, it means the provider call was started and may have
    succeeded, so recovery reconciles instead of resending. UNCONFIRMED is the honest terminal state
    for "the provider probably has it but we could not prove it" -- never resent automatically.
    """

    QUEUED = "queued", "Queued"
    SENDING = "sending", "Sending"
    SENT = "sent", "Sent"
    FAILED = "failed", "Failed"
    UNCONFIRMED = "unconfirmed", "Delivery unconfirmed"


class IdempotentSendMixin(models.Model):
    """Fields that make one outbound send happen at most once.

    ``idempotency_key`` is minted when the message row is created and is unique per organization: it
    is the key handed to providers that de-duplicate, and the key a sent message is looked up by
    when a crash loses our record of the provider's answer.
    """

    idempotency_key = models.UUIDField(default=uuid.uuid4, editable=False)
    send_attempts = models.PositiveSmallIntegerField(default=0)
    claimed_at = models.DateTimeField(null=True, blank=True)
    provider_attempted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        abstract = True


class EmailAccount(TenantModel):
    """One connected mailbox per member. Tokens are encrypted; the API never returns them."""

    OWNER_FIELD: ClassVar[str | None] = "membership"

    membership = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="email_accounts")
    provider = models.CharField(max_length=16, choices=EmailProvider.choices)
    email_address = models.EmailField(max_length=254)
    display_name = models.CharField(max_length=120, blank=True)
    status = models.CharField(max_length=16, choices=ConnectionStatus.choices, default=ConnectionStatus.CONNECTED)
    access_token_enc = models.TextField(blank=True)
    refresh_token_enc = models.TextField(blank=True)
    token_expires_at = models.DateTimeField(null=True, blank=True)
    scopes = models.JSONField(default=list, blank=True)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    sync_cursor = models.CharField(max_length=512, blank=True)
    error_message = models.CharField(max_length=255, blank=True)
    connected_at = models.DateTimeField(null=True, blank=True)
    disconnected_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "membership"],
                condition=models.Q(status__in=["connected", "error"]),
                name="uniq_active_email_account_per_member",
            )
        ]
        indexes = [models.Index(fields=["organization", "status"], name="emailaccount_org_status_idx")]

    def __str__(self) -> str:
        return f"{self.provider}:{self.email_address}"

    @property
    def is_usable(self) -> bool:
        return self.status in {ConnectionStatus.CONNECTED, ConnectionStatus.ERROR} and bool(self.refresh_token_enc)


class EmailTemplate(TenantModel):
    OWNER_FIELD: ClassVar[str | None] = "created_by"

    name = models.CharField(max_length=80)
    subject = models.CharField(max_length=255, blank=True)
    body = models.TextField()
    is_shared = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [models.UniqueConstraint(fields=["organization", "name"], name="uniq_email_template_name")]
        ordering = ["name"]


class MessageDirection(models.TextChoices):
    OUTBOUND = "outbound", "Outbound"
    INBOUND = "inbound", "Inbound"


class EmailMessage(IdempotentSendMixin, TenantModel):
    class Status(models.TextChoices):
        QUEUED = SendState.QUEUED.value, SendState.QUEUED.label
        SENDING = SendState.SENDING.value, SendState.SENDING.label
        SENT = SendState.SENT.value, SendState.SENT.label
        FAILED = SendState.FAILED.value, SendState.FAILED.label
        UNCONFIRMED = SendState.UNCONFIRMED.value, SendState.UNCONFIRMED.label
        RECEIVED = "received", "Received"

    OWNER_FIELD: ClassVar[str | None] = "sent_by"

    account = models.ForeignKey(EmailAccount, null=True, blank=True, on_delete=models.SET_NULL, related_name="messages")
    direction = models.CharField(max_length=8, choices=MessageDirection.choices)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.QUEUED)
    from_address = models.CharField(max_length=254, blank=True)
    to_addresses = models.JSONField(default=list, blank=True)
    cc_addresses = models.JSONField(default=list, blank=True)
    bcc_addresses = models.JSONField(default=list, blank=True)
    subject = models.CharField(max_length=255, blank=True)
    body_text = models.TextField(blank=True)
    snippet = models.CharField(max_length=300, blank=True)
    provider_message_id = models.CharField(max_length=255, blank=True)
    provider_thread_id = models.CharField(max_length=255, blank=True)
    in_reply_to = models.CharField(max_length=255, blank=True)
    contact = models.ForeignKey(
        "contacts.Contact", null=True, blank=True, on_delete=models.SET_NULL, related_name="emails"
    )
    company = models.ForeignKey(
        "companies.Company", null=True, blank=True, on_delete=models.SET_NULL, related_name="emails"
    )
    deal = models.ForeignKey("deals.Deal", null=True, blank=True, on_delete=models.SET_NULL, related_name="emails")
    sent_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    sent_at = models.DateTimeField(null=True, blank=True)
    received_at = models.DateTimeField(null=True, blank=True)
    error_message = models.CharField(max_length=255, blank=True)
    ai_assisted = models.BooleanField(default=False)
    template = models.ForeignKey(EmailTemplate, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        indexes = [
            models.Index(fields=["organization", "contact", "-created_at"], name="email_org_contact_idx"),
            models.Index(fields=["organization", "deal", "-created_at"], name="email_org_deal_idx"),
            models.Index(fields=["organization", "company", "-created_at"], name="email_org_company_idx"),
            models.Index(fields=["organization", "sent_by", "-created_at"], name="email_org_sender_idx"),
            models.Index(fields=["organization", "provider_thread_id"], name="email_org_thread_idx"),
            # The reconciliation sweeper reads exactly this: sends stuck mid-flight, oldest first.
            models.Index(fields=["status", "claimed_at"], name="email_status_claimed_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "account", "provider_message_id"],
                condition=~models.Q(provider_message_id=""),
                name="uniq_email_provider_message",
            ),
            models.UniqueConstraint(fields=["organization", "idempotency_key"], name="uniq_email_idempotency_key"),
        ]
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.direction} email {self.status}: {self.subject[:40]}"


class EmailAttachment(TenantModel):
    """Outbound attachment stored in private storage (never served directly; sent with the message)."""

    message = models.ForeignKey(EmailMessage, on_delete=models.CASCADE, related_name="attachments")
    filename = models.CharField(max_length=255)
    content_type = models.CharField(max_length=120)
    size_bytes = models.PositiveIntegerField()
    storage_key = models.CharField(max_length=512)


class WhatsAppAccount(TenantModel):
    """Organization-level WhatsApp Business Platform (Cloud API) connection."""

    phone_number_id = models.CharField(max_length=64)
    business_account_id = models.CharField(max_length=64, blank=True)
    display_phone = models.CharField(max_length=32, blank=True)
    display_name = models.CharField(max_length=120, blank=True)
    access_token_enc = models.TextField(blank=True)
    status = models.CharField(max_length=16, choices=ConnectionStatus.choices, default=ConnectionStatus.CONNECTED)
    error_message = models.CharField(max_length=255, blank=True)
    connected_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    connected_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization"], name="uniq_whatsapp_account_per_org"),
        ]
        indexes = [models.Index(fields=["phone_number_id"], name="wa_phone_number_idx")]


class WhatsAppTemplate(TenantModel):
    """Approved message templates (Meta-approved; recorded here so the composer can offer them)."""

    name = models.CharField(max_length=120)
    language = models.CharField(max_length=16, default="en")
    category = models.CharField(max_length=32, blank=True)
    body = models.TextField(blank=True)  # human-readable body with {{1}} placeholders
    parameter_count = models.PositiveSmallIntegerField(default=0)
    status = models.CharField(max_length=16, default="approved")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "name", "language"], name="uniq_whatsapp_template")
        ]
        ordering = ["name"]


class WhatsAppMessage(IdempotentSendMixin, TenantModel):
    class Status(models.TextChoices):
        QUEUED = SendState.QUEUED.value, SendState.QUEUED.label
        SENDING = SendState.SENDING.value, SendState.SENDING.label
        SENT = SendState.SENT.value, SendState.SENT.label
        DELIVERED = "delivered", "Delivered"
        READ = "read", "Read"
        FAILED = SendState.FAILED.value, SendState.FAILED.label
        UNCONFIRMED = SendState.UNCONFIRMED.value, SendState.UNCONFIRMED.label
        RECEIVED = "received", "Received"

    class Type(models.TextChoices):
        TEXT = "text", "Text"
        TEMPLATE = "template", "Template"

    OWNER_FIELD: ClassVar[str | None] = "sent_by"

    account = models.ForeignKey(
        WhatsAppAccount, null=True, blank=True, on_delete=models.SET_NULL, related_name="messages"
    )
    direction = models.CharField(max_length=8, choices=MessageDirection.choices)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.QUEUED)
    wa_id = models.CharField(max_length=32)  # customer phone in E.164 digits
    message_type = models.CharField(max_length=10, choices=Type.choices, default=Type.TEXT)
    body = models.TextField(blank=True)
    template = models.ForeignKey(WhatsAppTemplate, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    template_params = models.JSONField(default=list, blank=True)
    provider_message_id = models.CharField(max_length=255, blank=True)
    contact = models.ForeignKey(
        "contacts.Contact", null=True, blank=True, on_delete=models.SET_NULL, related_name="whatsapp_messages"
    )
    company = models.ForeignKey(
        "companies.Company", null=True, blank=True, on_delete=models.SET_NULL, related_name="whatsapp_messages"
    )
    deal = models.ForeignKey(
        "deals.Deal", null=True, blank=True, on_delete=models.SET_NULL, related_name="whatsapp_messages"
    )
    sent_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    sent_at = models.DateTimeField(null=True, blank=True)
    received_at = models.DateTimeField(null=True, blank=True)
    error_message = models.CharField(max_length=255, blank=True)
    ai_assisted = models.BooleanField(default=False)

    class Meta:
        indexes = [
            models.Index(fields=["organization", "wa_id", "-created_at"], name="wa_org_waid_idx"),
            models.Index(fields=["organization", "contact", "-created_at"], name="wa_org_contact_idx"),
            models.Index(fields=["organization", "deal", "-created_at"], name="wa_org_deal_idx"),
            models.Index(fields=["status", "claimed_at"], name="wa_status_claimed_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "provider_message_id"],
                condition=~models.Q(provider_message_id=""),
                name="uniq_whatsapp_provider_message",
            ),
            models.UniqueConstraint(fields=["organization", "idempotency_key"], name="uniq_whatsapp_idempotency_key"),
        ]
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.direction} whatsapp {self.status} to {self.wa_id}"
