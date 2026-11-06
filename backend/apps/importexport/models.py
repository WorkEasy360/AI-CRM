from __future__ import annotations

from typing import ClassVar

from django.db import models

from apps.core.models import TenantModel


class JobStatus(models.TextChoices):
    UPLOADED = "uploaded", "Uploaded"
    PREVIEWING = "previewing", "Checking"
    PREVIEWED = "previewed", "Checked"
    PENDING = "pending", "Pending"
    RUNNING = "running", "Running"
    COMPLETED = "completed", "Completed"
    # Stopped cleanly at the plan's record limit: everything before ``stop["row"]`` is imported.
    STOPPED = "stopped", "Stopped at limit"
    FAILED = "failed", "Failed"
    ROLLING_BACK = "rolling_back", "Rolling back"
    ROLLED_BACK = "rolled_back", "Rolled back"


class ImportJob(TenantModel):
    OWNER_FIELD: ClassVar[str | None] = "requested_by"

    entity_type = models.CharField(max_length=16)
    status = models.CharField(max_length=16, choices=JobStatus.choices, default=JobStatus.UPLOADED)
    storage_key = models.CharField(max_length=200)
    original_filename = models.CharField(max_length=120)
    file_format = models.CharField(max_length=8, default="csv")
    size_bytes = models.PositiveIntegerField(default=0)
    headers = models.JSONField(default=list, blank=True)
    mapping = models.JSONField(default=dict, blank=True)
    options = models.JSONField(default=dict, blank=True)
    total_rows = models.PositiveIntegerField(default=0)
    processed_rows = models.PositiveIntegerField(default=0)
    created_rows = models.PositiveIntegerField(default=0)
    updated_rows = models.PositiveIntegerField(default=0)
    skipped_rows = models.PositiveIntegerField(default=0)
    error_rows = models.PositiveIntegerField(default=0)
    errors = models.JSONField(default=list, blank=True)
    error_message = models.CharField(max_length=255, blank=True)
    # Dry-run result: counts to create/update/skip/fail, per-row errors, and where the plan limit would stop it.
    preview = models.JSONField(default=dict, blank=True)
    # Set when the run stopped at the record limit: {"row", "message", "upgrade"}.
    stop = models.JSONField(default=dict, blank=True)
    # Set by a rollback: {"deleted", "reverted", "missing", "conflicts": [...]}.
    rollback = models.JSONField(default=dict, blank=True)
    rolled_back_at = models.DateTimeField(null=True, blank=True)
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


class ImportRow(TenantModel):
    """What one import row did, kept so the import can be rolled back.

    ``created``: the record the row created (a rollback deletes it). ``updated``: the record it changed and
    ``before``, the values it overwrote, in write form (a rollback restores them). ``after_version`` is the
    record's version right after the import wrote it: a different version at rollback time means someone
    changed the record since, and the rollback reports a conflict instead of overwriting their work.
    """

    class Action(models.TextChoices):
        CREATED = "created", "Created"
        UPDATED = "updated", "Updated"

    job = models.ForeignKey(ImportJob, on_delete=models.CASCADE, related_name="row_refs")
    row_number = models.PositiveIntegerField()
    entity_type = models.CharField(max_length=16)
    entity_id = models.UUIDField()
    action = models.CharField(max_length=8, choices=Action.choices)
    before = models.JSONField(default=dict, blank=True)
    after_version = models.PositiveIntegerField(default=1)
    rolled_back = models.BooleanField(default=False)

    class Meta:
        indexes = [models.Index(fields=["organization", "job", "row_number"], name="importrow_org_job_row_idx")]


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
