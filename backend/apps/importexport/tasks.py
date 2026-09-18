"""Background jobs. ``tenant_task`` binds the organization; the requester's membership rebuilds the actor
so the job never runs with more rights than the person who asked for it."""

from __future__ import annotations

import uuid

import structlog
from celery import shared_task
from django.conf import settings
from django.utils import timezone

from apps.core.tenancy.context import system_context, tenant_atomic
from apps.core.tenancy.tasks import tenant_task
from apps.importexport import service
from apps.importexport.models import ExportJob, ImportJob, JobStatus

log = structlog.get_logger(__name__)


# Hard limits per task class: a runaway import cannot hold a heavy-worker slot for more than an hour, and
# the broker visibility timeout (see CELERY_VISIBILITY_TIMEOUT) is longer than every limit here so no job
# is ever started twice.
IMPORT_TIME_LIMIT = settings.IMPORT_TASK_TIME_LIMIT
EXPORT_TIME_LIMIT = 1800

# Jobs resumed per sweep. Bounded so one bad deploy cannot make the sweeper itself the outage.
RESUME_LIMIT = 50


# ``atomic=False``: an import commits batch by batch so progress is visible while it runs and a crash
# costs at most one batch. It opens its own transactions with ``tenant_atomic()``.
@tenant_task(
    name="importexport.run_import",
    soft_time_limit=IMPORT_TIME_LIMIT - 60,
    time_limit=IMPORT_TIME_LIMIT,
    atomic=False,
)
def run_import(*, job_id: str, organization_id, actor_membership_id: str, **kwargs) -> str:
    """Run (or resume) one import.

    Accepts a job that is PENDING or already RUNNING: the second case is a resume after a worker died,
    and ``service.process_import`` restarts from the job's checkpoint rather than from row one.
    """
    with tenant_atomic():
        job = ImportJob.objects.filter(pk=job_id, status__in=[JobStatus.PENDING, JobStatus.RUNNING]).first()
    if job is None:
        return "skipped"
    if job.attempts >= settings.IMPORT_MAX_ATTEMPTS:
        service.fail_import(job, "The import was retried too many times and was stopped.")
        return "failed"
    try:
        actor = service._actor_for_task(uuid.UUID(str(actor_membership_id)))
        service.process_import(job, actor)
        return "completed"
    except Exception as exc:
        log.exception("importexport.import_failed", job_id=job_id)
        with tenant_atomic():
            attempts = ImportJob.objects.filter(pk=job.pk).values_list("attempts", flat=True).first() or 0
        reason = str(getattr(exc, "message", "Import failed."))
        if attempts >= settings.IMPORT_MAX_ATTEMPTS:
            # Out of attempts: fail for good rather than resume something that keeps breaking.
            service.fail_import(job, reason)
            return "failed"
        # Recoverable as far as we know. The batches that committed stand, the checkpoint marks where
        # to pick up, and the sweeper will resume this job from there.
        service.interrupt_import(job, reason)
        return "interrupted"


@shared_task(name="importexport.resume_stalled_imports", ignore_result=True, soft_time_limit=120, time_limit=150)
def resume_stalled_imports() -> int:
    """Beat: pick up imports whose worker died mid-run.

    A RUNNING job whose ``updated_at`` has not moved for ``IMPORT_RESUME_AFTER`` is not making
    progress -- every batch touches that column. Re-enqueuing it restarts from the checkpoint, so the
    rows already committed are not imported a second time.
    """
    cutoff = timezone.now() - settings.IMPORT_RESUME_AFTER
    with system_context("importexport.resume_stalled_imports"):
        # Cross-tenant on purpose, and only just: this reads three ids per row (organization, job,
        # requester) and no imported data, inside a system context, then hands each job to a
        # tenant-bound task that re-binds its own organization. Same shape as integrations.drain.
        rows = list(
            ImportJob.all_objects.filter(  # nosemgrep: keel-unscoped-manager-outside-system-code
                status=JobStatus.RUNNING, updated_at__lt=cutoff
            )
            .filter(attempts__lt=settings.IMPORT_MAX_ATTEMPTS)
            .order_by("updated_at")
            .values_list("organization_id", "id", "requested_by_id")[:RESUME_LIMIT]
        )
    for org_id, job_id, membership_id in rows:
        if membership_id is None:
            continue
        run_import.apply_async(
            kwargs={
                "job_id": str(job_id),
                "organization_id": str(org_id),
                "actor_membership_id": str(membership_id),
            }
        )
    if rows:
        log.warning("importexport.resumed_stalled_imports", count=len(rows))
    return len(rows)


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
