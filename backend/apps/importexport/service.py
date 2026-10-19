"""Import and export jobs: request-time validation and the hand-off to background tasks.

Imports (mapping, presets, dedupe, dry-run preview, batched commit, clean stop at the plan limit and
rollback) live in ``apps.importexport.importing``; every row goes through the module's own create/update,
so validation, custom-field rules, field permissions, ownership, audit and events match the API exactly.
Exports re-apply ``authz.scope()`` and the module's FilterSet inside the task with the *requester's*
actor, never with wider rights, and write only the columns the module schema lets that actor see.
"""

from __future__ import annotations

import csv
import io
import uuid
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import structlog
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.accounts.models import Membership
from apps.audit import service as audit
from apps.authz.actor import Actor, build_actor
from apps.authz.service import check, scope
from apps.core.exceptions import DomainError
from apps.core.tenancy.context import tenant_atomic
from apps.crm import schema
from apps.importexport import csvsafe, importing, storage
from apps.importexport.models import ExportJob, ImportJob, JobStatus

log = structlog.get_logger(__name__)

MAX_IMPORT_ERRORS_STORED = importing.MAX_IMPORT_ERRORS_STORED
MAX_EXPORT_ROWS = 100_000
EXPORT_TTL_HOURS = 24
IMPORT_ENTITY_TYPES = importing.IMPORT_ENTITY_TYPES
EXPORT_ENTITY_TYPES = ("contact", "company", "product", "deal")
# "Full export": every module the requester may export, one CSV each, in one ZIP.
FULL_EXPORT = "all"
ACTIVE_JOB_STATUSES = (JobStatus.PENDING, JobStatus.RUNNING, JobStatus.PREVIEWING, JobStatus.ROLLING_BACK)

# ----------------------------------------------------------------------------- fairness


def _enqueue(task: Any, **kwargs: str) -> None:
    """Hand a committed job to its worker, best effort.

    Runs after COMMIT: the job row already exists, so a broker blip raising here only turned the accepted
    request into a 500 (and the client's retry into a second job). A job that never reaches a worker is
    failed by ``privacy.retention.fail_stale_jobs``, which also releases its quota slot.
    """
    try:
        task.delay(**kwargs)
    except Exception as exc:
        log.warning("importexport.enqueue_failed", task=task.name, job_id=kwargs.get("job_id"), error=str(exc)[:200])


def _active_jobs() -> int:
    """Jobs of this organization that hold or wait for a heavy worker slot."""
    active = ACTIVE_JOB_STATUSES
    return ImportJob.objects.filter(status__in=active).count() + ExportJob.objects.filter(status__in=active).count()


def _enforce_job_quota() -> None:
    """One tenant must not fill the heavy queues: cap pending+running jobs per organization."""
    if _active_jobs() >= settings.MAX_ACTIVE_JOBS_PER_ORG:
        raise DomainError(
            "Too many imports or exports are already in progress for this workspace. Wait for one to finish.",
            code="too_many_active_jobs",
            status_code=429,
        )


# ----------------------------------------------------------------------------- imports


def _module_for(entity_type: str) -> str:
    return schema.get(entity_type).module


def allowed_targets(actor: Actor | None, entity_type: str) -> dict[str, str]:
    return importing.targets(actor, entity_type)


def suggest_mapping(
    actor: Actor | None, entity_type: str, headers: Iterable[str], *, preset: str | None = None
) -> dict[str, str]:
    return importing.suggest(actor, entity_type, headers, preset=preset)


def create_import(actor: Actor, *, entity_type: str, uploaded: Any, request: Any = None) -> ImportJob:
    if entity_type not in IMPORT_ENTITY_TYPES:
        raise ValidationError({"entity_type": "Unsupported entity type."})
    check(actor, f"{_module_for(entity_type)}.import")
    raw, headers, count = csvsafe.validate_upload(uploaded)
    key = storage.new_key(actor.organization.pk, "imports")
    storage.write(key, raw)
    name = getattr(uploaded, "name", "") or ""
    job = ImportJob.objects.create(
        entity_type=entity_type,
        storage_key=key,
        original_filename=csvsafe.safe_filename(name),
        file_format="xlsx" if name.lower().endswith(".xlsx") else "csv",
        size_bytes=len(raw),
        headers=headers,
        total_rows=count,
        requested_by=actor.membership,
        mapping=suggest_mapping(actor, entity_type, headers),
    )
    audit.record(
        "imports.uploaded",
        request=request,
        user=actor.user,
        resource=job,
        metadata={
            "entity_type": entity_type,
            "rows": count,
            "filename": job.original_filename,
            "format": job.file_format,
        },
    )
    return job


def preview_rows(job: ImportJob, limit: int = 5) -> list[dict[str, str]]:
    raw = storage.read(job.storage_key)
    rows = []
    for _, row in csvsafe.iter_rows(raw, job.headers):
        rows.append({k: csvsafe.neutralise(v[:200]) for k, v in row.items()})
        if len(rows) >= limit:
            break
    return rows


def validate_mapping(actor: Actor | None, entity_type: str, headers: list[str], mapping: Any) -> dict[str, str]:
    return importing.validate_mapping(actor, entity_type, headers, mapping)


def _own_job(actor: Actor, job: ImportJob) -> None:
    check(actor, f"{_module_for(job.entity_type)}.import", job)
    if job.requested_by_id != actor.membership.pk:
        raise PermissionDenied(code="permission_denied")


@transaction.atomic
def start_preview(actor: Actor, job: ImportJob, *, mapping: Any, options: Any = None, request: Any = None) -> ImportJob:
    """Validate every row without writing (a background dry run). Allowed again after mapping changes."""
    from apps.importexport.tasks import run_import_preview

    _enforce_job_quota()
    _own_job(actor, job)
    if job.status not in (JobStatus.UPLOADED, JobStatus.PREVIEWED):
        raise DomainError("This import has already been started.", code="import_already_started", status_code=409)
    job.mapping = validate_mapping(actor, job.entity_type, job.headers, mapping)
    job.options = importing.clean_options(options)
    job.status = JobStatus.PREVIEWING
    job.preview = {}
    job.save(update_fields=["mapping", "options", "status", "preview", "updated_at"])
    audit.record(
        "imports.preview_requested",
        request=request,
        user=actor.user,
        resource=job,
        metadata={"entity_type": job.entity_type, "mapping": job.mapping, "options": job.options},
    )
    transaction.on_commit(
        lambda: _enqueue(
            run_import_preview,
            job_id=str(job.pk),
            organization_id=str(job.organization_id),
            actor_membership_id=str(actor.membership.pk),
        )
    )
    return job


def run_preview(job: ImportJob, actor: Actor) -> ImportJob:
    _own_job(actor, job)
    result = importing.preview(job, actor)
    with tenant_atomic():
        ImportJob.objects.filter(pk=job.pk, status=JobStatus.PREVIEWING).update(
            preview=result, status=JobStatus.PREVIEWED, updated_at=timezone.now()
        )
    job.refresh_from_db()
    return job


@transaction.atomic
def start_import(
    actor: Actor, job: ImportJob, *, mapping: Any = None, options: Any = None, request: Any = None
) -> ImportJob:
    """Commit the import. From a checked (previewed) job the checked mapping is used unless one is sent."""
    _enforce_job_quota()
    from apps.importexport.tasks import run_import

    _own_job(actor, job)
    if job.status not in (JobStatus.UPLOADED, JobStatus.PREVIEWED):
        raise DomainError("This import has already been started.", code="import_already_started", status_code=409)
    if mapping is not None or job.status == JobStatus.UPLOADED:
        job.mapping = validate_mapping(actor, job.entity_type, job.headers, mapping)
        job.options = importing.clean_options(options)
    job.status = JobStatus.PENDING
    job.save(update_fields=["mapping", "options", "status", "updated_at"])
    audit.record(
        "imports.started",
        request=request,
        user=actor.user,
        resource=job,
        metadata={"entity_type": job.entity_type, "mapping": job.mapping, "options": job.options},
    )
    transaction.on_commit(
        lambda: _enqueue(
            run_import,
            job_id=str(job.pk),
            organization_id=str(job.organization_id),
            actor_membership_id=str(actor.membership.pk),
        )
    )
    return job


def start_rollback(actor: Actor, job: ImportJob, *, request: Any = None) -> ImportJob:
    from apps.importexport.tasks import run_import_rollback

    _enforce_job_quota()
    job = importing.start_rollback(actor, job, request=request)
    transaction.on_commit(
        lambda: _enqueue(
            run_import_rollback,
            job_id=str(job.pk),
            organization_id=str(job.organization_id),
            actor_membership_id=str(actor.membership.pk),
        )
    )
    return job


def _actor_for_task(membership_id: uuid.UUID) -> Actor:
    membership = (
        Membership.objects.active().select_related("user", "role", "organization").filter(pk=membership_id).first()
    )
    if membership is None:
        raise PermissionDenied(detail="Requester is no longer an active member.", code="permission_denied")
    return build_actor(membership)


def process_import(job: ImportJob, actor: Actor) -> ImportJob:
    """Run one import to completion (or to the plan limit). Resumable: see ``importing.process``."""
    return importing.process(job, actor)


def process_rollback(job: ImportJob, actor: Actor) -> ImportJob:
    return importing.rollback(job, actor)


def interrupt_import(job: ImportJob, message: str) -> None:
    """Record that a run stopped part-way, and leave the job resumable.

    Deliberately keeps the job RUNNING and keeps the uploaded file: the checkpoint plus the file are
    the only things that let ``resume_stalled_imports`` carry on from where this run stopped. Deleting
    the file here (which is what ``fail_import`` does) would make the job unresumable for good.
    """
    with tenant_atomic():
        ImportJob.objects.filter(pk=job.pk).update(
            status=JobStatus.RUNNING, error_message=message[:255], updated_at=timezone.now()
        )
    log.warning("importexport.import_interrupted", job_id=str(job.pk), checkpoint_row=job.checkpoint_row)


def fail_import(job: ImportJob, message: str) -> None:
    """Give up on a job for good. Rows already committed by earlier batches stay: the job reports how
    far it got (``processed_rows`` / ``created_rows``) so the failure is explicit rather than silent.

    Terminal, so the uploaded file is released here.
    """
    with tenant_atomic():
        ImportJob.objects.filter(pk=job.pk).update(
            status=JobStatus.FAILED,
            error_message=message[:255],
            finished_at=timezone.now(),
            updated_at=timezone.now(),
        )
        audit.record(
            "imports.failed",
            organization_id=job.organization_id,
            resource=job,
            metadata={"reason": message[:255], "checkpoint_row": job.checkpoint_row},
        )
    storage.delete(job.storage_key)


# ----------------------------------------------------------------------------- exports


def create_export(actor: Actor, *, entity_type: str, filters: dict[str, str], request: Any = None) -> ExportJob:
    from apps.authz.reauth import require_recent_auth
    from apps.importexport.tasks import run_export

    if entity_type not in (*EXPORT_ENTITY_TYPES, FULL_EXPORT):
        raise ValidationError({"entity_type": "Unsupported entity type."})
    if entity_type == FULL_EXPORT:
        if not full_export_modules(actor):
            raise PermissionDenied(code="permission_denied")
    else:
        check(actor, f"{_module_for(entity_type)}.export")
    if request is not None:
        require_recent_auth(request)
    _enforce_job_quota()
    clean = {k: str(v)[:200] for k, v in filters.items() if k not in {"cursor", "limit", "expand", "format"}}
    if entity_type == FULL_EXPORT:
        clean = {}  # a full export is everything the requester may see, unfiltered
    else:
        filterset, _ = _filterset_and_queryset(entity_type)
        filterset.apply(_base_queryset(entity_type), clean, actor=actor)  # validate now; re-applied in the task
    with transaction.atomic():
        job = ExportJob.objects.create(
            entity_type=entity_type,
            filters=clean,
            requested_by=actor.membership,
            expires_at=timezone.now() + timedelta(hours=EXPORT_TTL_HOURS),
        )
        audit.record(
            "exports.requested",
            request=request,
            user=actor.user,
            resource=job,
            metadata={"entity_type": entity_type, "filters": clean},
        )
        transaction.on_commit(
            lambda: _enqueue(
                run_export,
                job_id=str(job.pk),
                organization_id=str(job.organization_id),
                actor_membership_id=str(actor.membership.pk),
            )
        )
    return job


def _filterset_and_queryset(entity_type: str):
    binding = schema.get(entity_type).bind()
    return binding.filterset, binding.queryset


def _base_queryset(entity_type: str):
    return schema.get(entity_type).bind().queryset()


def export_columns(actor: Actor, entity_type: str) -> list[schema.FieldDef]:
    """What an export of ``entity_type`` contains for ``actor``: the module schema minus hidden fields."""
    return [f for f in schema.fields_for(actor, entity_type) if f.exportable]


def _write_module_csv(actor: Actor, entity_type: str, filters: dict[str, str]) -> tuple[bytes, int]:
    from apps.tagging import service as tagging

    module = schema.get(entity_type)
    qs = scope(actor, f"{module.module}.view", _base_queryset(entity_type)).filter(archived_at__isnull=True)
    filterset, _ = _filterset_and_queryset(entity_type)
    qs, ordering = filterset.apply(qs, filters, actor=actor)
    qs = qs.order_by(*ordering)
    total = qs.count()
    if total > MAX_EXPORT_ROWS:
        raise DomainError(f"Export exceeds {MAX_EXPORT_ROWS} rows. Narrow the filters.", code="export_too_large")
    # Field-level permissions apply to exports exactly as to the API: hidden columns are left out.
    columns = export_columns(actor, entity_type)
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(["ID"] + [c.label for c in columns])
    count = 0
    batch: list[Any] = []
    with_tags = any(c.type == schema.TAGS for c in columns)

    def flush(rows: list[Any]) -> None:
        tags_map = tagging.tags_for(entity_type, [r.pk for r in rows]) if with_tags else None
        for r in rows:
            values = [schema.display_text(schema.read_value(r, c, tags_map=tags_map)) for c in columns]
            writer.writerow([str(r.pk)] + [csvsafe.neutralise(v) for v in values])

    for obj in qs.iterator(chunk_size=500):
        batch.append(obj)
        count += 1
        if len(batch) >= 500:
            flush(batch)
            batch = []
    if batch:
        flush(batch)
    return ("\ufeff" + buffer.getvalue()).encode("utf-8"), count


def process_export(job: ExportJob, actor: Actor) -> ExportJob:
    if job.requested_by_id != actor.membership.pk:
        raise PermissionDenied(code="permission_denied")
    if job.entity_type == FULL_EXPORT:
        modules = full_export_modules(actor)
        if not modules:
            raise PermissionDenied(code="permission_denied")
    else:
        check(actor, f"{_module_for(job.entity_type)}.export", job)
        modules = [job.entity_type]
    job.status = JobStatus.RUNNING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])
    if job.entity_type == FULL_EXPORT:
        archive = io.BytesIO()
        count = 0
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for entity_type in modules:
                data, n = _write_module_csv(actor, entity_type, {})
                zf.writestr(f"{schema.get(entity_type).label_plural.lower()}.csv", data)
                count += n
        data = archive.getvalue()
    else:
        data, count = _write_module_csv(actor, job.entity_type, job.filters)
    key = storage.new_key(job.organization_id, "exports")
    storage.write(key, data)
    job.storage_key, job.size_bytes, job.row_count = key, len(data), count
    job.status = JobStatus.COMPLETED
    job.finished_at = timezone.now()
    job.save(update_fields=["storage_key", "size_bytes", "row_count", "status", "finished_at", "updated_at"])
    audit.record(
        "exports.completed",
        user=actor.user,
        resource=job,
        metadata={"entity_type": job.entity_type, "rows": count, "modules": modules},
    )
    return job


def full_export_modules(actor: Actor) -> list[str]:
    return [m for m in EXPORT_ENTITY_TYPES if actor.has(f"{_module_for(m)}.export")]


def fail_export(job: ExportJob, message: str) -> None:
    ExportJob.objects.filter(pk=job.pk).update(
        status=JobStatus.FAILED, error_message=message[:255], finished_at=timezone.now(), updated_at=timezone.now()
    )


@dataclass(frozen=True)
class Download:
    """What the API needs to hand the file over: either bytes to stream, or a short-lived signed URL."""

    filename: str
    data: bytes | None = None
    url: str | None = None


def open_download(actor: Actor, job: ExportJob, *, request: Any = None) -> Download:
    """Authorize, audit and resolve the download. Only the requester may download, and only before expiry.

    With the S3 backend the bytes never pass through the API: the response is a redirect to a signed URL
    that expires in ``PRIVATE_STORAGE_URL_TTL_SECONDS``.
    """
    if job.entity_type != FULL_EXPORT:
        check(actor, f"{_module_for(job.entity_type)}.export", job)
    elif not full_export_modules(actor):
        raise PermissionDenied(code="permission_denied")
    if job.requested_by_id != actor.membership.pk or job.status != JobStatus.COMPLETED or not job.storage_key:
        from django.http import Http404

        raise Http404
    if job.expires_at and job.expires_at < timezone.now():
        raise DomainError("This export has expired. Request a new one.", code="export_expired", status_code=410)
    if storage.organization_of(job.storage_key) != job.organization_id:  # defensive: never serve across tenants
        raise PermissionDenied(code="permission_denied")
    if not storage.exists(job.storage_key):
        raise DomainError("The export file is no longer available.", code="export_missing", status_code=410)
    if job.entity_type == FULL_EXPORT:
        filename = f"workeasy-export-{job.created_at:%Y%m%d-%H%M%S}.zip"
    else:
        filename = f"{job.entity_type}s-{job.created_at:%Y%m%d-%H%M%S}.csv"
    if storage.supports_signed_urls():
        download = Download(filename=filename, url=storage.signed_download_url(job.storage_key, filename))
    else:
        download = Download(filename=filename, data=storage.read(job.storage_key))
    ExportJob.objects.filter(pk=job.pk).update(download_count=job.download_count + 1)
    audit.record(
        "exports.downloaded",
        request=request,
        user=actor.user,
        resource=job,
        metadata={"entity_type": job.entity_type, "rows": job.row_count},
    )
    return download
