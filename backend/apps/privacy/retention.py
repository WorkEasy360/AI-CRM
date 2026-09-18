"""Retention jobs that run system-wide (outside any tenant) from Celery beat.

This module is one of the few reviewed places allowed to use ``all_objects``: every function opens a
``system_context`` with a reason, touches only bookkeeping columns, and is idempotent.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from django.utils import timezone

from apps.core.tenancy.context import system_context
from apps.importexport import storage
from apps.importexport.models import ExportJob, ImportJob, JobStatus

# Longer than the broker visibility timeout (2 h: when a task lost with its worker is redelivered) plus
# the longest job hard limit (1 h). A job older than this that is still pending never reached a worker.
STALE_JOB_AFTER = timedelta(hours=4)
STALE_JOB_MESSAGE = "The job could not be started. Please try again."


def purge_expired_exports(*, now: Any = None, limit: int = 500) -> int:
    """Delete stored files of expired export jobs (system-wide, runs from Celery beat). The rows stay for
    the job history; only ``storage_key`` is cleared. Returns the number of files removed."""
    now = now or timezone.now()
    removed = 0
    with system_context("importexport.purge_expired"):
        expired = list(
            ExportJob.all_objects.filter(expires_at__lt=now).exclude(storage_key="").order_by("expires_at")[:limit]
        )
        for job in expired:
            storage.delete(job.storage_key)
            ExportJob.all_objects.filter(pk=job.pk).update(storage_key="", updated_at=now)
            removed += 1
    return removed


def fail_stale_jobs(*, now: Any = None, limit: int = 500) -> int:
    """Fail import/export jobs stuck in pending/running, releasing their per-organization quota slots.

    Without this, a job whose enqueue was lost (broker blip after COMMIT) or whose worker was killed
    stayed pending forever and counted against ``MAX_ACTIVE_JOBS_PER_ORG``: three such jobs locked the
    organization out of imports and exports for good. A job a worker is processing has saved its status
    inside the task's transaction and holds that row lock, so ``skip_locked`` never touches it.
    Idempotent; touches only bookkeeping columns.
    """
    now = now or timezone.now()
    cutoff = now - STALE_JOB_AFTER
    failed = 0
    with system_context("importexport.fail_stale_jobs"):
        for model in (ImportJob, ExportJob):
            stale = list(
                model.all_objects.filter(status__in=[JobStatus.PENDING, JobStatus.RUNNING], updated_at__lt=cutoff)
                .select_for_update(skip_locked=True)
                .order_by("updated_at")
                .values_list("pk", "storage_key")[:limit]
            )
            if not stale:
                continue
            failed += model.all_objects.filter(pk__in=[pk for pk, _ in stale]).update(
                status=JobStatus.FAILED, error_message=STALE_JOB_MESSAGE, finished_at=now, updated_at=now
            )
            if model is ImportJob:
                for _, key in stale:
                    storage.delete(key)  # the upload is never going to be imported
    return failed
