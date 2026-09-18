"""Import and export jobs: request-time validation and the row processing run by background tasks.

Every imported row goes through the same write serializer and record service as the API, so validation,
custom-field rules, ownership and audit logging are identical. Exports re-apply ``authz.scope()`` and
the module's FilterSet inside the task with the *requester's* actor, never with wider rights.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

import structlog
from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.accounts.models import Membership
from apps.audit import service as audit
from apps.authz.actor import Actor, build_actor
from apps.authz.service import check, scope
from apps.core.exceptions import DomainError
from apps.core.tenancy.context import tenant_atomic
from apps.crm import records
from apps.dashboards import cache as dashboard_cache
from apps.importexport import csvsafe, storage
from apps.importexport.models import ExportJob, ImportJob, JobStatus

log = structlog.get_logger(__name__)

MAX_IMPORT_ERRORS_STORED = 500
MAX_EXPORT_ROWS = 100_000
EXPORT_TTL_HOURS = 24
IMPORT_ENTITY_TYPES = ("contact", "company", "product")
EXPORT_ENTITY_TYPES = ("contact", "company", "product", "deal")

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
    active = (JobStatus.PENDING, JobStatus.RUNNING)
    return ImportJob.objects.filter(status__in=active).count() + ExportJob.objects.filter(status__in=active).count()


def _enforce_job_quota() -> None:
    """One tenant must not fill the heavy queues: cap pending+running jobs per organization."""
    if _active_jobs() >= settings.MAX_ACTIVE_JOBS_PER_ORG:
        raise DomainError(
            "Too many imports or exports are already in progress for this workspace. Wait for one to finish.",
            code="too_many_active_jobs",
            status_code=429,
        )


# ----------------------------------------------------------------------------- entity descriptors

# Column targets that an import mapping may point at, per entity. Custom fields are added dynamically
# as ``custom.<key>``. Everything else is rejected, so a mapping can never reach owner/organization/version.
IMPORT_FIELDS: dict[str, dict[str, str]] = {
    "contact": {
        "first_name": "First name",
        "last_name": "Last name",
        "email": "Email",
        "phone": "Phone",
        "job_title": "Job title",
        "company_name": "Company name",
        "source": "Source",
        "description": "Description",
    },
    "company": {
        "name": "Name",
        "website": "Website",
        "phone": "Phone",
        "industry": "Industry",
        "company_size": "Company size",
        "annual_revenue": "Annual revenue",
        "revenue_currency": "Revenue currency",
        "source": "Source",
        "description": "Description",
    },
    "product": {
        "name": "Name",
        "sku": "SKU",
        "description": "Description",
        "unit_price": "Unit price",
        "currency": "Currency",
        "tax_rate": "Tax rate",
        "tax_label": "Tax label",
        "status": "Status",
    },
}

_ALIASES: dict[str, dict[str, str]] = {
    "contact": {
        "firstname": "first_name",
        "lastname": "last_name",
        "name": "first_name",
        "e-mail": "email",
        "mail": "email",
        "telephone": "phone",
        "mobile": "phone",
        "title": "job_title",
        "company": "company_name",
        "organisation": "company_name",
        "organization": "company_name",
    },
    "company": {
        "company": "name",
        "company name": "name",
        "url": "website",
        "web": "website",
        "telephone": "phone",
        "size": "company_size",
        "revenue": "annual_revenue",
    },
    "product": {"product": "name", "product name": "name", "price": "unit_price", "code": "sku", "tax": "tax_rate"},
}


def _module_for(entity_type: str) -> str:
    return {"contact": "contacts", "company": "companies", "product": "products", "deal": "deals"}[entity_type]


def _spec_and_serializer(entity_type: str):
    if entity_type == "contact":
        from apps.contacts.api import SPEC, ContactWriteSerializer

        return SPEC, ContactWriteSerializer
    if entity_type == "company":
        from apps.companies.api import SPEC, CompanyWriteSerializer

        return SPEC, CompanyWriteSerializer
    if entity_type == "product":
        from apps.products.api import SPEC, ProductWriteSerializer

        return SPEC, ProductWriteSerializer
    raise ValidationError({"entity_type": "Unsupported entity type."})


def _filterset_and_queryset(entity_type: str):
    if entity_type == "contact":
        from apps.contacts.api import FILTERS, ContactViewSet

        return FILTERS, ContactViewSet
    if entity_type == "company":
        from apps.companies.api import FILTERS, CompanyViewSet

        return FILTERS, CompanyViewSet
    if entity_type == "product":
        from apps.products.api import FILTERS, ProductViewSet

        return FILTERS, ProductViewSet
    if entity_type == "deal":
        from apps.deals.api import FILTERS, DealViewSet

        return FILTERS, DealViewSet
    raise ValidationError({"entity_type": "Unsupported entity type."})


def allowed_targets(entity_type: str) -> dict[str, str]:
    from apps.customfields import service as customfields

    targets = dict(IMPORT_FIELDS[entity_type])
    for d in customfields.active_definitions(entity_type):
        targets[f"custom.{d.key}"] = f"{d.label} (custom)"
    return targets


def suggest_mapping(entity_type: str, headers: Iterable[str]) -> dict[str, str]:
    targets = allowed_targets(entity_type)
    by_label = {label.lower(): key for key, label in targets.items()}
    by_label.update(
        {label.lower().removesuffix(" (custom)"): key for key, label in targets.items() if key.startswith("custom.")}
    )
    by_key = {key.lower(): key for key in targets}
    by_key.update({key[7:].lower(): key for key in targets if key.startswith("custom.")})
    aliases = _ALIASES.get(entity_type, {})
    mapping: dict[str, str] = {}
    used: set[str] = set()
    for header in headers:
        h = header.strip().lower()
        candidate = by_key.get(h) or by_key.get(h.replace(" ", "_")) or by_label.get(h) or aliases.get(h)
        if candidate and candidate not in used:
            mapping[header] = candidate
            used.add(candidate)
    return mapping


# ----------------------------------------------------------------------------- imports


def create_import(actor: Actor, *, entity_type: str, uploaded: Any, request: Any = None) -> ImportJob:
    if entity_type not in IMPORT_ENTITY_TYPES:
        raise ValidationError({"entity_type": "Unsupported entity type."})
    check(actor, f"{_module_for(entity_type)}.import")
    raw, headers, count = csvsafe.validate_upload(uploaded)
    key = storage.new_key(actor.organization.pk, "imports")
    storage.write(key, raw)
    job = ImportJob.objects.create(
        entity_type=entity_type,
        storage_key=key,
        original_filename=csvsafe.safe_filename(getattr(uploaded, "name", "")),
        size_bytes=len(raw),
        headers=headers,
        total_rows=count,
        requested_by=actor.membership,
        mapping=suggest_mapping(entity_type, headers),
    )
    audit.record(
        "imports.uploaded",
        request=request,
        user=actor.user,
        resource=job,
        metadata={"entity_type": entity_type, "rows": count, "filename": job.original_filename},
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


def validate_mapping(entity_type: str, headers: list[str], mapping: Any) -> dict[str, str]:
    if not isinstance(mapping, dict) or not mapping:
        raise ValidationError({"mapping": "Map at least one column."})
    targets = allowed_targets(entity_type)
    cleaned: dict[str, str] = {}
    seen: set[str] = set()
    for header, target in mapping.items():
        if header not in headers:
            raise ValidationError({"mapping": f"Unknown column '{str(header)[:60]}'."})
        if not target:
            continue
        if target not in targets:
            raise ValidationError({"mapping": f"'{str(target)[:60]}' is not an importable field."})
        if target in seen:
            raise ValidationError({"mapping": f"'{target}' is mapped twice."})
        seen.add(target)
        cleaned[header] = target
    if not cleaned:
        raise ValidationError({"mapping": "Map at least one column."})
    return cleaned


@transaction.atomic
def start_import(actor: Actor, job: ImportJob, *, mapping: Any, options: Any = None, request: Any = None) -> ImportJob:
    _enforce_job_quota()
    from apps.importexport.tasks import run_import

    check(actor, f"{_module_for(job.entity_type)}.import", job)
    if job.requested_by_id != actor.membership.pk:
        raise PermissionDenied(code="permission_denied")
    if job.status != JobStatus.UPLOADED:
        raise DomainError("This import has already been started.", code="import_already_started", status_code=409)
    job.mapping = validate_mapping(job.entity_type, job.headers, mapping)
    opts = options if isinstance(options, dict) else {}
    job.options = {"create_companies": bool(opts.get("create_companies", True))}
    job.status = JobStatus.PENDING
    job.save(update_fields=["mapping", "options", "status", "updated_at"])
    audit.record(
        "imports.started",
        request=request,
        user=actor.user,
        resource=job,
        metadata={"entity_type": job.entity_type, "mapping": job.mapping},
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


def _actor_for_task(membership_id: uuid.UUID) -> Actor:
    membership = (
        Membership.objects.active().select_related("user", "role", "organization").filter(pk=membership_id).first()
    )
    if membership is None:
        raise PermissionDenied(detail="Requester is no longer an active member.", code="permission_denied")
    return build_actor(membership)


def _row_payload(entity_type: str, row: dict[str, str], mapping: dict[str, str]) -> tuple[dict[str, Any], str | None]:
    payload: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    company_name: str | None = None
    for header, target in mapping.items():
        value = (row.get(header) or "").strip()
        if target.startswith("custom."):
            custom[target[7:]] = value if value != "" else None
        elif target == "company_name":
            company_name = value or None
        elif target in {"annual_revenue", "unit_price", "tax_rate"}:
            payload[target] = csvsafe.parse_decimal(value) if value else None
            if payload[target] is None:
                payload.pop(target)
        elif target == "status" and entity_type == "product":
            payload[target] = value.lower() or "active"
        else:
            payload[target] = value
    if custom:
        payload["custom_data"] = custom
    return payload, company_name


def _resolve_company(actor: Actor, name: str, *, create: bool) -> Any:
    from apps.companies.api import SPEC as COMPANY_SPEC
    from apps.companies.models import Company
    from apps.core import validators

    name = validators.clean_text(name, max_length=160)
    if not name:
        return None
    existing = scope(
        actor, "companies.view", Company.objects.filter(name__iexact=name, archived_at__isnull=True)
    ).first()
    if existing is not None or not create:
        return existing
    if not actor.has("companies.create"):
        return None
    return records.create(actor, COMPANY_SPEC, {"name": name}, request=None)


# ----------------------------------------------------------------------------- importing
#
# An import is PARTIAL and RESUMABLE, never all-or-nothing. That choice is deliberate and is what the
# UI, the API and the error report all promise:
#
#   - rows are processed in batches of ``settings.IMPORT_BATCH_SIZE``;
#   - one batch is one transaction. Every row in it commits together, or none of it does;
#   - a row that fails validation is *reported* and skipped (its own savepoint), so one bad row
#     never discards the good rows around it;
#   - the progress counters and the checkpoint are written **in the same transaction as the rows they
#     describe**. What the progress bar shows is therefore exactly what is in the database -- there is
#     no window in which a row exists but is uncounted, or is counted but rolled back;
#   - a job whose worker dies is resumed from ``checkpoint_row`` by the sweeper. Rows inside already
#     committed batches are skipped, so resuming can never create a record twice.
#
# The thing this replaces was one transaction around the whole file: progress was invisible until the
# end, a 100k-row import held one transaction (and its locks and its snapshot) for minutes, and a
# failure at row 99,000 threw away everything.


def _import_batches(rows, batch_size: int):
    """Group ``(row_number, row)`` pairs into lists of at most ``batch_size``."""
    batch = []
    for item in rows:
        batch.append(item)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


def process_import(job: ImportJob, actor: Actor) -> ImportJob:
    """Run one import to completion, committing as it goes. Safe to call again after a crash."""
    spec, serializer_class = _spec_and_serializer(job.entity_type)
    permission = f"{_module_for(job.entity_type)}.import"
    check(actor, permission, job)
    if job.requested_by_id != actor.membership.pk:
        raise PermissionDenied(code="permission_denied")

    with tenant_atomic():
        started = job.started_at or timezone.now()
        ImportJob.objects.filter(pk=job.pk).update(
            status=JobStatus.RUNNING, started_at=started, attempts=F("attempts") + 1, updated_at=timezone.now()
        )
        job.refresh_from_db()
    dashboard_cache.invalidate(job.organization_id)

    raw = storage.read(job.storage_key)
    # Resume point: every row at or below this number is already committed.
    resume_after = job.checkpoint_row
    state = _ImportState(
        processed=job.processed_rows, created=job.created_rows, failed=job.error_rows, errors=list(job.errors or [])
    )
    company_cache: dict[str, Any] = {}
    create_companies = bool(job.options.get("create_companies", True)) and job.entity_type == "contact"
    batch_size = max(1, settings.IMPORT_BATCH_SIZE)

    pending = ((n, row) for n, row in csvsafe.iter_rows(raw, job.headers) if n > resume_after)
    for batch in _import_batches(pending, batch_size):
        _run_batch(
            job,
            actor,
            spec,
            serializer_class,
            batch,
            state=state,
            company_cache=company_cache,
            create_companies=create_companies,
        )

    with tenant_atomic():
        ImportJob.objects.filter(pk=job.pk).update(
            processed_rows=state.processed,
            created_rows=state.created,
            error_rows=state.failed,
            errors=state.errors,
            status=JobStatus.COMPLETED,
            finished_at=timezone.now(),
            updated_at=timezone.now(),
        )
        audit.record(
            "imports.completed",
            user=actor.user,
            resource=job,
            metadata={
                "entity_type": job.entity_type,
                "created": state.created,
                "errors": state.failed,
                "resumed_from_row": resume_after,
            },
        )
    storage.delete(job.storage_key)
    job.refresh_from_db()
    return job


@dataclass
class _ImportState:
    processed: int = 0
    created: int = 0
    failed: int = 0
    errors: list[dict[str, Any]] = field(default_factory=list)


def _run_batch(
    job: ImportJob,
    actor: Actor,
    spec,
    serializer_class,
    batch: list[tuple[int, dict[str, str]]],
    *,
    state: _ImportState,
    company_cache: dict[str, Any],
    create_companies: bool,
) -> None:
    """One bounded transaction: this batch's rows plus the checkpoint that describes them.

    Counters are mutated on a copy first and only written back to ``state`` once the transaction has
    committed, so a batch that is rolled back cannot leave the in-memory tally ahead of the database.
    """
    local = _ImportState(
        processed=state.processed, created=state.created, failed=state.failed, errors=list(state.errors)
    )
    # A company created for a row that later rolls back must not stay in the cache as if it existed.
    cache_before = dict(company_cache)
    last_row = batch[-1][0]
    try:
        with tenant_atomic():
            for row_no, row in batch:
                local.processed += 1
                payload, company_name = _row_payload(job.entity_type, row, job.mapping)
                try:
                    with transaction.atomic():  # savepoint: one bad row, not one bad batch
                        if company_name:
                            key = company_name.lower()
                            if key not in company_cache:
                                company_cache[key] = _resolve_company(actor, company_name, create=create_companies)
                            if company_cache[key] is not None:
                                payload["company_id"] = company_cache[key].pk
                        ser = serializer_class(data=payload, context={"actor": actor})
                        ser.is_valid(raise_exception=True)
                        records.create(
                            actor, spec, ser.validated_data, request=None, audit_extra={"import_job_id": str(job.pk)}
                        )
                    local.created += 1
                except ValidationError as exc:
                    local.failed += 1
                    if len(local.errors) < MAX_IMPORT_ERRORS_STORED:
                        local.errors.append({"row": row_no, "errors": _flatten(exc.detail)})
                except (DomainError, PermissionDenied) as exc:
                    local.failed += 1
                    if len(local.errors) < MAX_IMPORT_ERRORS_STORED:
                        local.errors.append(
                            {
                                "row": row_no,
                                "errors": [
                                    {"field": "non_field_errors", "message": str(getattr(exc, "message", exc))[:200]}
                                ],
                            }
                        )
            # Written inside the same transaction as the rows above: progress can never disagree
            # with the data, in either direction.
            ImportJob.objects.filter(pk=job.pk).update(
                processed_rows=local.processed,
                created_rows=local.created,
                error_rows=local.failed,
                errors=local.errors,
                checkpoint_row=last_row,
                updated_at=timezone.now(),
            )
    except Exception:
        company_cache.clear()
        company_cache.update(cache_before)
        log.exception("importexport.batch_failed", job_id=str(job.pk), first_row=batch[0][0], last_row=last_row)
        raise
    state.processed, state.created, state.failed, state.errors = (
        local.processed,
        local.created,
        local.failed,
        local.errors,
    )


def _flatten(detail: Any, prefix: str = "") -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if isinstance(detail, dict):
        for k, v in detail.items():
            out.extend(_flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(detail, list):
        for item in detail:
            out.extend(_flatten(item, prefix))
    else:
        out.append({"field": prefix or "non_field_errors", "message": str(detail)[:200]})
    return out[:20]


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

    if entity_type not in EXPORT_ENTITY_TYPES:
        raise ValidationError({"entity_type": "Unsupported entity type."})
    check(actor, f"{_module_for(entity_type)}.export")
    if request is not None:
        require_recent_auth(request)
    _enforce_job_quota()
    filterset, _ = _filterset_and_queryset(entity_type)
    clean = {k: str(v)[:200] for k, v in filters.items() if k not in {"cursor", "limit", "expand", "format"}}
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


def _base_queryset(entity_type: str):
    _, viewset = _filterset_and_queryset(entity_type)
    view = viewset()
    return view.base_queryset()


EXPORT_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "contact": [
        ("id", "ID"),
        ("first_name", "First name"),
        ("last_name", "Last name"),
        ("email", "Email"),
        ("phone", "Phone"),
        ("job_title", "Job title"),
        ("company.name", "Company"),
        ("source", "Source"),
        ("owner.user.display_name", "Owner"),
        ("created_at", "Created at"),
        ("updated_at", "Updated at"),
    ],
    "company": [
        ("id", "ID"),
        ("name", "Name"),
        ("website", "Website"),
        ("phone", "Phone"),
        ("industry", "Industry"),
        ("company_size", "Company size"),
        ("annual_revenue", "Annual revenue"),
        ("revenue_currency", "Revenue currency"),
        ("source", "Source"),
        ("owner.user.display_name", "Owner"),
        ("created_at", "Created at"),
        ("updated_at", "Updated at"),
    ],
    "product": [
        ("id", "ID"),
        ("name", "Name"),
        ("sku", "SKU"),
        ("unit_price", "Unit price"),
        ("currency", "Currency"),
        ("tax_rate", "Tax rate"),
        ("tax_label", "Tax label"),
        ("status", "Status"),
        ("owner.user.display_name", "Owner"),
        ("created_at", "Created at"),
        ("updated_at", "Updated at"),
    ],
    "deal": [
        ("id", "ID"),
        ("name", "Name"),
        ("pipeline.name", "Pipeline"),
        ("stage.name", "Stage"),
        ("status", "Status"),
        ("amount", "Amount"),
        ("currency", "Currency"),
        ("amount_base", "Amount (base)"),
        ("probability", "Probability"),
        ("expected_close_date", "Expected close"),
        ("closed_at", "Closed at"),
        ("company.name", "Company"),
        ("primary_contact.display_name", "Primary contact"),
        ("owner.user.display_name", "Owner"),
        ("created_at", "Created at"),
        ("updated_at", "Updated at"),
    ],
}


def _dig(obj: Any, path: str) -> Any:
    for part in path.split("."):
        if obj is None:
            return None
        obj = getattr(obj, part, None)
    return obj


def process_export(job: ExportJob, actor: Actor) -> ExportJob:
    from apps.customfields import service as customfields
    from apps.tagging import service as tagging

    module = _module_for(job.entity_type)
    check(actor, f"{module}.export", job)
    if job.requested_by_id != actor.membership.pk:
        raise PermissionDenied(code="permission_denied")
    job.status = JobStatus.RUNNING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])
    filterset, _ = _filterset_and_queryset(job.entity_type)
    qs = scope(actor, f"{module}.view", _base_queryset(job.entity_type)).filter(archived_at__isnull=True)
    qs, ordering = filterset.apply(qs, job.filters, actor=actor)
    qs = qs.order_by(*ordering)
    total = qs.count()
    if total > MAX_EXPORT_ROWS:
        raise DomainError(f"Export exceeds {MAX_EXPORT_ROWS} rows. Narrow the filters.", code="export_too_large")
    definitions = customfields.active_definitions(job.entity_type)
    columns = EXPORT_COLUMNS[job.entity_type]
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow([label for _, label in columns] + [d.label for d in definitions] + ["Tags"])
    count = 0
    batch: list[Any] = []

    def flush(rows: list[Any]) -> None:
        tags_map = tagging.tags_for(job.entity_type, [r.pk for r in rows])
        for r in rows:
            values = [csvsafe.neutralise(_dig(r, path)) for path, _ in columns]
            values += [csvsafe.neutralise(_format_custom(r.custom_data.get(d.key))) for d in definitions]
            values.append(csvsafe.neutralise("; ".join(t.name for t in tags_map.get(r.pk, []))))
            writer.writerow(values)

    for obj in qs.iterator(chunk_size=500):
        batch.append(obj)
        count += 1
        if len(batch) >= 500:
            flush(batch)
            batch = []
    if batch:
        flush(batch)
    data = ("﻿" + buffer.getvalue()).encode("utf-8")
    key = storage.new_key(job.organization_id, "exports")
    storage.write(key, data)
    job.storage_key, job.size_bytes, job.row_count = key, len(data), count
    job.status = JobStatus.COMPLETED
    job.finished_at = timezone.now()
    job.save(update_fields=["storage_key", "size_bytes", "row_count", "status", "finished_at", "updated_at"])
    audit.record(
        "exports.completed", user=actor.user, resource=job, metadata={"entity_type": job.entity_type, "rows": count}
    )
    return job


def _format_custom(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    return str(value)


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
    module = _module_for(job.entity_type)
    check(actor, f"{module}.export", job)
    if job.requested_by_id != actor.membership.pk or job.status != JobStatus.COMPLETED or not job.storage_key:
        from django.http import Http404

        raise Http404
    if job.expires_at and job.expires_at < timezone.now():
        raise DomainError("This export has expired. Request a new one.", code="export_expired", status_code=410)
    if storage.organization_of(job.storage_key) != job.organization_id:  # defensive: never serve across tenants
        raise PermissionDenied(code="permission_denied")
    if not storage.exists(job.storage_key):
        raise DomainError("The export file is no longer available.", code="export_missing", status_code=410)
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
