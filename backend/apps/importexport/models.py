from __future__ import annotations

from typing import ClassVar

from django.db import models

from apps.core.models import TenantModel


class JobStatus(models.TextChoices):
    UPLOADED = "uploaded", "Uploaded"
    PENDING = "pending", "Pending"
    RUNNING = "running", "Running"
    COMPLETED = "completed", "Completed"
    FAILED = "failed", "Failed"


class ImportJob(TenantModel):
    OWNER_FIELD: ClassVar[str | None] = "requested_by"

    entity_type = models.CharField(max_length=16)
    status = models.CharField(max_length=16, choices=JobStatus.choices, default=JobStatus.UPLOADED)
    storage_key = models.CharField(max_length=200)
    original_filename = models.CharField(max_length=120)
    size_bytes = models.PositiveIntegerField(default=0)
    headers = models.JSONField(default=list, blank=True)
    mapping = models.JSONField(default=dict, blank=True)
    options = models.JSONField(default=dict, blank=True)
    total_rows = models.PositiveIntegerField(default=0)
    processed_rows = models.PositiveIntegerField(default=0)
    created_rows = models.PositiveIntegerField(default=0)
    error_rows = models.PositiveIntegerField(default=0)
    errors = models.JSONField(default=list, blank=True)
    error_message = models.CharField(max_length=255, blank=True)
    # The last CSV row number inside a committed batch. Written in the same transaction as that
    # batch's rows, which is what makes a resumed job pick up without re-creating anything.
    checkpoint_row = models.PositiveIntegerField(default=0)
    # How many times a worker has started this job. Bounds resumption after repeated crashes.
    attempts = models.PositiveSmallIntegerField(default=0)
    requested_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["organization", "-created_at"], name="importjob_org_created_idx"),
            # The resume sweeper's read path: jobs left RUNNING by a worker that died.
            models.Index(fields=["status", "updated_at"], name="importjob_status_updated_idx"),
        ]
        ordering = ["-created_at"]


class ExportJob(TenantModel):
    OWNER_FIELD: ClassVar[str | None] = "requested_by"

    entity_type = models.CharField(max_length=16)
    status = models.CharField(max_length=16, choices=JobStatus.choices, default=JobStatus.PENDING)
    filters = models.JSONField(default=dict, blank=True)
    row_count = models.PositiveIntegerField(default=0)
    storage_key = models.CharField(max_length=200, blank=True)
    size_bytes = models.PositiveIntegerField(default=0)
    error_message = models.CharField(max_length=255, blank=True)
    requested_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    download_count = models.PositiveIntegerField(default=0)

    class Meta:
        indexes = [models.Index(fields=["organization", "-created_at"], name="exportjob_org_created_idx")]
        ordering = ["-created_at"]
