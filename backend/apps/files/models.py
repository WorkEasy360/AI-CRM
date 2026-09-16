from __future__ import annotations

from typing import ClassVar

from django.db import models

from apps.core.models import TenantModel

FILE_ENTITY_TYPES = ("contact", "company", "deal", "product")

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FILES_PER_RECORD = 25
MAX_UPLOAD_PARTS = 5

# Deliberately narrow. Anything that a browser could execute if it ever escaped the attachment
# disposition (html, svg, xml, js) stays out; downloads are always served as attachments with nosniff.
ALLOWED_CONTENT_TYPES: frozenset[str] = frozenset(
    {
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "text/plain",
        "text/csv",
        "application/msword",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
)


class FileAttachment(TenantModel):
    """A file attached to a CRM record. Bytes live in private storage; only this row is tenant data.

    ``uploaded_by`` is the owner field so own/team scopes apply to deletion.
    """

    OWNER_FIELD: ClassVar[str | None] = "uploaded_by"

    entity_type = models.CharField(max_length=16)
    entity_id = models.UUIDField()
    filename = models.CharField(max_length=255)
    content_type = models.CharField(max_length=120)
    size_bytes = models.PositiveIntegerField()
    storage_key = models.CharField(max_length=512)
    uploaded_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        indexes = [
            models.Index(
                fields=["organization", "entity_type", "entity_id", "-created_at"], name="file_org_entity_created_idx"
            ),
        ]
        ordering = ["-created_at"]
