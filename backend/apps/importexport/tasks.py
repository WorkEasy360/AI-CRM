"""Background jobs. ``tenant_task`` binds the organization; the requester's membership rebuilds the actor
so the job never runs with more rights than the person who asked for it."""

from __future__ import annotations

import uuid

import structlog
from celery import shared_task

from apps.core.tenancy.tasks import tenant_task
from apps.importexport import service
from apps.importexport.models import ExportJob, ImportJob, JobStatus

log = structlog.get_logger(__name__)


# Hard limits per task class: a runaway import cannot hold a heavy-worker slot for more than an hour, and
# the broker visibility timeout (2h) is longer than every limit here so no job is ever started twice.
IMPORT_TIME_LIMIT = 3600
EXPORT_TIME_LIMIT = 1800


@tenant_task(name="importexport.run_import", soft_time_limit=IMPORT_TIME_LIMIT - 60, time_limit=IMPORT_TIME_LIMIT)
def run_import(*, job_id: str, organization_id, actor_membership_id: str, **kwargs) -> str:
    job = ImportJob.objects.filter(pk=job_id, status=JobStatus.PENDING).first()
    if job is None:
        return "skipped"
    try:
        actor = service._actor_for_task(uuid.UUID(str(actor_membership_id)))
        service.process_import(job, actor)
        return "completed"
    except Exception as exc:
        log.exception("importexport.import_failed", job_id=job_id)
        service.fail_import(job, str(getattr(exc, "message", "Import failed.")))
        return "failed"


@tenant_task(name="importexport.run_export", soft_time_limit=EXPORT_TIME_LIMIT - 60, time_limit=EXPORT_TIME_LIMIT)
def run_export(*, job_id: str, organization_id, actor_membership_id: str, **kwargs) -> str:
    job = ExportJob.objects.filter(pk=job_id, status=JobStatus.PENDING).first()
    if job is None:
        return "skipped"
    try:
        actor = service._actor_for_task(uuid.UUID(str(actor_membership_id)))
        service.process_export(job, actor)
        return "completed"
    except Exception as exc:
        log.exception("importexport.export_failed", job_id=job_id)
        service.fail_export(job, str(getattr(exc, "message", "Export failed.")))
        return "failed"


@shared_task(name="importexport.purge_expired", ignore_result=True, soft_time_limit=240, time_limit=300)
def purge_expired() -> int:
    """Beat task: remove export files past their expiry (the S3 lifecycle rule is the backstop)."""
    from apps.privacy import retention

    removed = retention.purge_expired_exports()
    log.info("importexport.purged_expired", removed=removed)
    return removed


@shared_task(name="importexport.fail_stale_jobs", ignore_result=True, soft_time_limit=120, time_limit=150)
def fail_stale_jobs() -> int:
    """Beat task: fail jobs that never reached a worker so they stop holding the organization's job quota."""
    from apps.privacy import retention

    failed = retention.fail_stale_jobs()
    if failed:
        log.warning("importexport.stale_jobs_failed", count=failed)
    return failed
