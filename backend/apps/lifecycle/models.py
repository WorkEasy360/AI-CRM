from __future__ import annotations

from django.db import models

from apps.core.models import TenantModel
from apps.lifecycle.stages import LifecycleStage


class LifecycleHistory(TenantModel):
    """Append-only (database trigger): one row per lifecycle transition of a contact or company."""

    class Source(models.TextChoices):
        USER = "user", "User"
        AUTOMATION = "automation", "Automation"
        IMPORT = "import", "Import"

    entity_type = models.CharField(max_length=16)  # "contact" | "company"
    entity_id = models.UUIDField()
    from_stage = models.CharField(max_length=16, choices=LifecycleStage.choices, blank=True)
    to_stage = models.CharField(max_length=16, choices=LifecycleStage.choices)
    changed_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    changed_at = models.DateTimeField()
    source = models.CharField(max_length=16, choices=Source.choices, default=Source.USER)
    reason = models.CharField(max_length=255, blank=True)

    class Meta:
        indexes = [
            models.Index(
                fields=["organization", "entity_type", "entity_id", "-changed_at"], name="lifecycle_entity_idx"
            ),
            models.Index(fields=["organization", "to_stage", "-changed_at"], name="lifecycle_org_stage_idx"),
        ]
        ordering = ["-changed_at"]
