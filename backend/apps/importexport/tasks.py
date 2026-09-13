"""Background jobs. ``tenant_task`` binds the organization; the requester's membership rebuilds the actor
so the job never runs with more rights than the person who asked for it."""

from __future__ import annotations

import uuid

import structlog

from apps.core.tenancy.tasks import tenant_task
from apps.importexport import service
from apps.importexport.models import ExportJob, ImportJob, JobStatus

log = structlog.get_logger(__name__)


@tenant_task(name="importexport.run_import")
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


@tenant_task(name="importexport.run_export")
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
