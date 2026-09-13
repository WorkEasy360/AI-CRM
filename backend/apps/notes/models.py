from __future__ import annotations

from typing import ClassVar

from django.db import models

from apps.core.models import TenantModel

NOTE_ENTITY_TYPES = ("contact", "company", "deal", "product")
MAX_NOTE_LENGTH = 20_000


class Note(TenantModel):
    """Plain-text note attached to a record. ``author`` is the owner field for own/team scopes."""

    OWNER_FIELD: ClassVar[str | None] = "author"

    entity_type = models.CharField(max_length=16)
    entity_id = models.UUIDField()
    body = models.TextField()
    author = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    pinned = models.BooleanField(default=False)
    edited_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(
                fields=["organization", "entity_type", "entity_id", "-created_at"], name="note_org_entity_created_idx"
            ),
        ]
        ordering = ["-pinned", "-created_at"]
