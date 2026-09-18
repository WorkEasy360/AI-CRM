"""Integration Hub: connections to external software, what they may exchange, and the delivery pipeline.

Every table is tenant-owned (``TenantModel``) and protected by forced RLS (migration 0001). Secrets
(access/refresh tokens, API keys, client secrets, webhook signing secrets) are stored only as
``apps.core.crypto`` ciphertext in ``*_enc`` columns, or as a one-way hash for credentials Keel issues
itself (``ApiCredential.secret_hash``). No serializer exposes those columns.

Google Workspace, Microsoft 365 and WhatsApp keep their existing tables in ``apps.messaging``; the hub
reads them through provider adapters instead of copying their credentials here.
"""

from __future__ import annotations

from django.db import models

from apps.core.models import TenantModel


class ConnectionStatus(models.TextChoices):
    CONNECTED = "connected", "Connected"
    DISCONNECTED = "disconnected", "Disconnected"
    ACTION_REQUIRED = "action_required", "Action required"
    SYNCING = "syncing", "Syncing"
    ERROR = "error", "Error"
    DISABLED = "disabled", "Paused"


class AuthType(models.TextChoices):
    OAUTH2_CODE = "oauth2_code", "OAuth 2.0 (authorization code + PKCE)"
    OAUTH2_CLIENT_CREDENTIALS = "oauth2_client_credentials", "OAuth 2.0 (client credentials)"
    API_KEY = "api_key", "API key"
    BEARER_TOKEN = "bearer_token", "Bearer token"  # nosec B105 - label, not a secret
    SIGNED_WEBHOOK = "signed_webhook", "Signed webhook only"


class Direction(models.TextChoices):
    NONE = "none", "Not shared"
    OUTBOUND = "outbound", "CRM → External"
    INBOUND = "inbound", "External → CRM"
    TWO_WAY = "two_way", "Two-way"


class ConflictStrategy(models.TextChoices):
    CRM_WINS = "crm_wins", "CRM wins"
    EXTERNAL_WINS = "external_wins", "External wins"
    NEWEST_WINS = "newest_wins", "Newest update wins"
    MANUAL = "manual", "Manual resolution"


class IntegrationConnection(TenantModel):
    """One configured connection to an external system (organization-wide)."""

    provider = models.CharField(max_length=32)
    name = models.CharField(max_length=80)
    status = models.CharField(max_length=16, choices=ConnectionStatus.choices, default=ConnectionStatus.DISCONNECTED)
    auth_type = models.CharField(max_length=32, choices=AuthType.choices)
    # Fernet ciphertext of a JSON object ({"api_key": ...}, {"access_token": ..., "refresh_token": ...}).
    credentials_enc = models.TextField(blank=True)
    token_expires_at = models.DateTimeField(null=True, blank=True)
    scopes = models.JSONField(default=list, blank=True)
    # Non-secret settings: base_url, resources per entity, header names, OAuth endpoints, client_id.
    config = models.JSONField(default=dict, blank=True)
    conflict_strategy = models.CharField(
        max_length=16, choices=ConflictStrategy.choices, default=ConflictStrategy.MANUAL
    )
    sync_interval_minutes = models.PositiveIntegerField(default=0)  # 0 = manual sync only
    next_sync_at = models.DateTimeField(null=True, blank=True)

    # Inbound webhook endpoint: the URL carries a random key (stored hashed); requests are
    # authenticated by an HMAC signature with ``inbound_secret_enc``.
    inbound_enabled = models.BooleanField(default=False)
    inbound_key_hash = models.CharField(max_length=64, blank=True, db_index=True)
    inbound_secret_enc = models.TextField(blank=True)
    inbound_previous_secret_enc = models.TextField(blank=True)
    inbound_previous_secret_expires_at = models.DateTimeField(null=True, blank=True)

    connected_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    connected_at = models.DateTimeField(null=True, blank=True)
    disconnected_at = models.DateTimeField(null=True, blank=True)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    last_success_at = models.DateTimeField(null=True, blank=True)
    last_error_code = models.CharField(max_length=64, blank=True)
    last_error_at = models.DateTimeField(null=True, blank=True)
    consecutive_failures = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "name"], name="uniq_integration_name_per_org"),
        ]
        indexes = [
            models.Index(fields=["organization", "status"], name="intconn_org_status_idx"),
            models.Index(fields=["status", "next_sync_at"], name="intconn_status_next_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.provider}:{self.name}"


class SharingPolicy(TenantModel):
    """Which CRM data one connection may exchange, and in which direction. Absent row = not shared."""

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="policies")
    entity_type = models.CharField(max_length=16)
    direction = models.CharField(max_length=8, choices=Direction.choices, default=Direction.NONE)
    external_resource = models.CharField(max_length=255, blank=True)  # e.g. "/contacts"

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["connection", "entity_type"], name="uniq_sharing_policy_entity"),
        ]


class FieldMapping(TenantModel):
    """One CRM field ↔ one external field. The server allowlist decides what may ever be mapped."""

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="mappings")
    entity_type = models.CharField(max_length=16)
    crm_field = models.CharField(max_length=80)  # "email" or "custom.<key>"
    external_field = models.CharField(max_length=128)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["connection", "entity_type", "crm_field"], name="uniq_field_mapping_crm"),
            models.UniqueConstraint(
                fields=["connection", "entity_type", "external_field"], name="uniq_field_mapping_external"
            ),
        ]


class IntegrationRecordMap(TenantModel):
    """CRM record ↔ external record, with the state last synchronized (for idempotency and conflicts)."""

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="record_maps")
    entity_type = models.CharField(max_length=16)
    crm_record_id = models.UUIDField()
    external_record_id = models.CharField(max_length=255)
    last_synced_version = models.PositiveIntegerField(default=0)
    last_crm_hash = models.CharField(max_length=64, blank=True)
    last_external_hash = models.CharField(max_length=64, blank=True)
    last_synced_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["connection", "entity_type", "crm_record_id"], name="uniq_record_map_crm"),
            models.UniqueConstraint(
                fields=["connection", "entity_type", "external_record_id"], name="uniq_record_map_external"
            ),
        ]


class SyncJob(TenantModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        COMPLETED = "completed", "Completed"
        FAILED = "failed", "Failed"

    class Trigger(models.TextChoices):
        MANUAL = "manual", "Manual"
        SCHEDULED = "scheduled", "Scheduled"

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="jobs")
    trigger = models.CharField(max_length=10, choices=Trigger.choices, default=Trigger.MANUAL)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    # Resume state between batches: {"phase": "push"|"pull", "entity_index": 0, "cursor": ...}.
    state = models.JSONField(default=dict, blank=True)
    processed = models.PositiveIntegerField(default=0)
    succeeded = models.PositiveIntegerField(default=0)
    failed = models.PositiveIntegerField(default=0)
    conflicts = models.PositiveIntegerField(default=0)
    # Most recent problems, capped: [{"entity_type", "record_id", "code"}]. Codes only, no provider text.
    errors = models.JSONField(default=list, blank=True)
    error_code = models.CharField(max_length=64, blank=True)
    triggered_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["connection"],
                condition=models.Q(status__in=["pending", "processing"]),
                name="uniq_active_sync_job_per_connection",
            )
        ]
        indexes = [models.Index(fields=["organization", "connection", "-created_at"], name="syncjob_org_conn_idx")]


class SyncConflict(TenantModel):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        KEPT_CRM = "kept_crm", "Kept CRM values"
        APPLIED_EXTERNAL = "applied_external", "Applied external values"

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="conflicts")
    entity_type = models.CharField(max_length=16)
    crm_record_id = models.UUIDField()
    external_record_id = models.CharField(max_length=255)
    fields = models.JSONField(default=list, blank=True)  # CRM field names that differ
    # Mapped, allowlisted inbound values waiting for a decision (never anything outside the mapping).
    external_values = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    resolved_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "entity_type", "crm_record_id"],
                condition=models.Q(status="open"),
                name="uniq_open_conflict_per_record",
            )
        ]


class IntegrationEvent(TenantModel):
    """Transactional outbox: written in the same transaction as the CRM change, delivered after COMMIT."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        DISPATCHED = "dispatched", "Dispatched"
        FAILED = "failed", "Failed"

    event_type = models.CharField(max_length=40)
    entity_type = models.CharField(max_length=16)
    entity_id = models.UUIDField()
    # Set when the change was written by an inbound sync, so it is not echoed back to that connection.
    origin_connection = models.ForeignKey(
        IntegrationConnection, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    dispatched_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["status", "created_at"], name="intevent_status_created_idx"),
            models.Index(fields=["organization", "-created_at"], name="intevent_org_created_idx"),
        ]


class WebhookSubscription(TenantModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        PAUSED = "paused", "Paused"
        DISABLED = "disabled", "Disabled after repeated failures"

    name = models.CharField(max_length=80)
    url = models.CharField(max_length=2048)
    event_types = models.JSONField(default=list)
    # False = thin events (ids only); True = the allowlisted standard fields of the record.
    include_data = models.BooleanField(default=False)
    secret_enc = models.TextField()
    previous_secret_enc = models.TextField(blank=True)
    previous_secret_expires_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.ACTIVE)
    consecutive_failures = models.PositiveIntegerField(default=0)
    last_success_at = models.DateTimeField(null=True, blank=True)
    last_failure_at = models.DateTimeField(null=True, blank=True)
    last_error_code = models.CharField(max_length=64, blank=True)
    created_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        indexes = [models.Index(fields=["organization", "status"], name="webhooksub_org_status_idx")]


class OutboundDelivery(TenantModel):
    """One event going to one destination: a webhook subscription or a connection (record push).

    Durable retry state: a failed attempt sets ``next_attempt_at`` (exponential backoff with jitter,
    honouring Retry-After) and the sweeper picks it up; permanent failures stop immediately.
    ``event_id`` is stable across attempts, so receivers can de-duplicate.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        SUCCEEDED = "succeeded", "Delivered"
        SKIPPED = "skipped", "Nothing to send"
        FAILED = "failed", "Failed"  # permanent (4xx, blocked destination, lost access)
        DEAD = "dead", "Gave up after retries"

    subscription = models.ForeignKey(
        WebhookSubscription, null=True, blank=True, on_delete=models.CASCADE, related_name="deliveries"
    )
    connection = models.ForeignKey(
        IntegrationConnection, null=True, blank=True, on_delete=models.CASCADE, related_name="deliveries"
    )
    source_event = models.ForeignKey(
        IntegrationEvent, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    event_id = models.UUIDField()  # sent as Keel-Event-Id; equals the source event id (random for pings)
    event_type = models.CharField(max_length=40)
    entity_type = models.CharField(max_length=16, blank=True)
    entity_id = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    response_status = models.PositiveSmallIntegerField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(subscription__isnull=False, connection__isnull=True)
                    | models.Q(subscription__isnull=True, connection__isnull=False)
                ),
                name="outbound_delivery_one_target",
            ),
            models.UniqueConstraint(
                fields=["subscription", "event_id"],
                condition=models.Q(subscription__isnull=False),
                name="uniq_delivery_subscription_event",
            ),
            models.UniqueConstraint(
                fields=["connection", "event_id"],
                condition=models.Q(connection__isnull=False),
                name="uniq_delivery_connection_event",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "next_attempt_at"], name="outdel_status_next_idx"),
            models.Index(fields=["organization", "subscription", "-created_at"], name="outdel_org_sub_idx"),
            models.Index(fields=["organization", "connection", "-created_at"], name="outdel_org_conn_idx"),
        ]


class InboundEvent(TenantModel):
    """One received webhook call. ``(connection, event_id)`` is unique: a replay is processed once."""

    class Status(models.TextChoices):
        RECEIVED = "received", "Received"
        PROCESSED = "processed", "Processed"
        FAILED = "failed", "Failed"

    connection = models.ForeignKey(IntegrationConnection, on_delete=models.CASCADE, related_name="inbound_events")
    event_id = models.CharField(max_length=128)
    event_type = models.CharField(max_length=40)
    payload = models.JSONField(default=dict, blank=True)  # cleared once processed (data minimization)
    payload_sha256 = models.CharField(max_length=64)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.RECEIVED)
    error_code = models.CharField(max_length=64, blank=True)
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["connection", "event_id"], name="uniq_inbound_event_id"),
        ]


class ApiCredential(TenantModel):
    """A scoped machine credential for external software calling the Keel API.

    The full key (``keel_<prefix>_<secret>``) is shown once. Only ``prefix`` (lookup) and the SHA-256 of
    the 256-bit random secret are stored. The credential acts through ``created_by``'s membership with
    the intersection of that member's current grants and the credential's scopes, so it can never do
    more than its creator could, and stops working when the creator loses access.
    """

    name = models.CharField(max_length=80)
    prefix = models.CharField(max_length=16, unique=True)
    secret_hash = models.CharField(max_length=64)
    scopes = models.JSONField(default=list)
    created_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    expires_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        indexes = [models.Index(fields=["organization", "-created_at"], name="apicred_org_created_idx")]
