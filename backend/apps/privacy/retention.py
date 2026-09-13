"""Retention jobs that run system-wide (outside any tenant) from Celery beat.

This module is one of the few reviewed places allowed to use ``all_objects``: every function opens a
``system_context`` with a reason, touches only bookkeeping columns, and is idempotent.
"""

from __future__ import annotations

from typing import Any

from django.utils import timezone

from apps.core.tenancy.context import system_context
from apps.importexport import storage
from apps.importexport.models import ExportJob


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
