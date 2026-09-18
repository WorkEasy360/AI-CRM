"""In-app notifications with per-member preferences. Few kinds, each of them actionable."""

from __future__ import annotations

from typing import ClassVar

from django.db import models

from apps.core.models import TenantModel


class NotificationKind(models.TextChoices):
    TASK_DUE = "task_due", "Task due"
    MEETING_SOON = "meeting_soon", "Meeting approaching"
    CALL_SOON = "call_soon", "Call scheduled"
    DEAL_ASSIGNED = "deal_assigned", "Deal assigned to you"
    DEAL_INACTIVE = "deal_inactive", "Deal inactivity warning"
    CUSTOMER_REPLIED = "customer_replied", "Customer replied"
    AI_HIGH_RISK = "ai_high_risk", "Deal at high risk"
    INTEGRATION_ALERT = "integration_alert", "Integration needs attention"


NOTIFICATION_KINDS: tuple[str, ...] = tuple(NotificationKind.values)


class Notification(TenantModel):
    OWNER_FIELD: ClassVar[str | None] = "recipient"

    recipient = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="notifications")
    kind = models.CharField(max_length=32, choices=NotificationKind.choices)
    title = models.CharField(max_length=200)
    body = models.CharField(max_length=500, blank=True)
    entity_type = models.CharField(max_length=16, blank=True)
    entity_id = models.UUIDField(null=True, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["organization", "recipient", "read_at", "-created_at"], name="notif_recipient_idx"),
            models.Index(fields=["organization", "recipient", "kind", "entity_id"], name="notif_dedupe_idx"),
        ]
        ordering = ["-created_at"]


class NotificationPreference(TenantModel):
    """Per member: which kinds arrive in-app and which also by email. Missing key = default on."""

    membership = models.OneToOneField(
        "accounts.Membership", on_delete=models.CASCADE, related_name="notification_preference"
    )
    in_app = models.JSONField(default=dict, blank=True)
    email = models.JSONField(default=dict, blank=True)
    # Deals with no activity for this many days trigger an inactivity warning (0 disables).
    deal_inactive_days = models.PositiveSmallIntegerField(default=14)
