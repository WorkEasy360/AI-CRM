"""Imports: column mapping, migration presets, dedupe, dry-run preview, batched commit, clean stop at the
plan's record limit, and rollback.

Every row is written through the module's own create/update (``apps.crm.schema`` bindings), exactly like
the API: the same validation, custom-field rules, field permissions, ownership, plan limit, audit and
domain events. Import targets come from the module schema as the requester sees it, so a hidden or
read-only field can never be an import target.

An import is PARTIAL and RESUMABLE (see ``process``): rows are committed in batches of
``IMPORT_BATCH_SIZE``, one transaction per batch, with the progress counters and the checkpoint written in
the same transaction as the rows they describe. A row that fails validation is reported and skipped.

Plan limit: a create refused by ``entitlements.consume`` stops the import there. The rows before it stay
committed (the checkpoint says exactly which), nothing after it is attempted, and the job carries the
problem's ``upgrade`` member so the UI names the plan or add-on that lifts the limit.

Rollback (``rollback``): each row's effect is kept in ``ImportRow``. Created records are deleted, updated
records get their previous values back, and the record counter is given back. A record changed by
someone else since the import (its version moved), or one other records now depend on, is reported as a
conflict and left alone.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

import structlog
from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check, scope
from apps.billing import entitlements
from apps.core.domain_events import RecordChanged, publish
from apps.core.exceptions import ConflictError, DomainError
from apps.core.tenancy.context import tenant_atomic
from apps.crm import schema
from apps.dashboards import cache as dashboard_cache
from apps.importexport import csvsafe, storage
from apps.importexport.models import ImportJob, ImportRow, JobStatus

log = structlog.get_logger(__name__)

IMPORT_ENTITY_TYPES = ("contact", "company", "product", "deal")
MAX_IMPORT_ERRORS_STORED = 500
DEDUPE_MODES = ("create", "skip", "update")
# Legacy target names kept so saved mappings and API clients from before Milestone 2 keep working.
TARGET_ALIASES = {"company_name": "company"}

# ----------------------------------------------------------------------------- migration presets
#
# Header -> field maps for the export shapes of common CRMs. Field-mapping presets only (DECISIONS
# M2.18): the import pipeline, dedupe and rollback are the same as for any file.

PRESETS: dict[str, dict[str, Any]] = {
    "zoho_crm": {
        "label": "Zoho CRM export",
        "maps": {
            "contact": {
                "First Name": "first_name",
                "Last Name": "last_name",
                "Email": "email",
                "Phone": "phone",
                "Mobile": "phone",
                "Title": "job_title",
                "Account Name": "company",
                "Lead Source": "source",
                "Description": "description",
            },
            "company": {
                "Account Name": "name",
                "Website": "website",
                "Phone": "phone",
                "Industry": "industry",
                "Annual Revenue": "annual_revenue",
                "Description": "description",
            },
            "deal": {
                "Deal Name": "name",
                "Amount": "amount",
                "Closing Date": "expected_close_date",
                "Stage": "stage",
                "Pipeline": "pipeline",
                "Probability (%)": "probability",
                "Account Name": "company",
                "Contact Name": "primary_contact",
                "Description": "description",
            },
            "product": {
                "Product Name": "name",
                "Product Code": "sku",
                "Unit Price": "unit_price",
                "Tax": "tax_rate",
                "Description": "description",
            },
        },
    },
    "hubspot": {
        "label": "HubSpot export",
        "maps": {
            "contact": {
                "First Name": "first_name",
                "Last Name": "last_name",
                "Email": "email",
                "Phone Number": "phone",
                "Job Title": "job_title",
                "Company Name": "company",
                "Original Source": "source",
            },
            "company": {
                "Company name": "name",
                "Company Domain Name": "website",
                "Phone Number": "phone",
                "Industry": "industry",
                "Annual Revenue": "annual_revenue",
                "Description": "description",
            },
            "deal": {
                "Deal Name": "name",
                "Amount": "amount",
                "Close Date": "expected_close_date",
                "Deal Stage": "stage",
                "Pipeline": "pipeline",
                "Deal Description": "description",
            },
            "product": {"Name": "name", "SKU": "sku", "Unit price": "unit_price", "Description": "description"},
        },
    },
    "pipedrive": {
        "label": "Pipedrive export",
        "maps": {
            "contact": {
                "Person - Name": "first_name",
                "Person - Email": "email",
                "Person - Phone": "phone",
                "Person - Job title": "job_title",
                "Person - Organization": "company",
            },
            "company": {
                "Organization - Name": "name",
                "Organization - Website": "website",
                "Organization - Industry": "industry",
                "Organization - Annual revenue": "annual_revenue",
            },
            "deal": {
                "Deal - Title": "name",
                "Deal - Value": "amount",
                "Deal - Currency": "currency",
                "Deal - Expected close date": "expected_close_date",
                "Deal - Stage": "stage",
                "Deal - Pipeline": "pipeline",
                "Deal - Organization": "company",
                "Deal - Contact person": "primary_contact",
            },
            "product": {
                "Product - Name": "name",
                "Product - Product code": "sku",
                "Product - Unit prices": "unit_price",
                "Product - Tax": "tax_rate",
                "Product - Description": "description",
            },
        },
    },
}


def presets(entity_type: str) -> list[dict[str, Any]]:
    return [
        {"key": k, "label": p["label"], "mapping": p["maps"].get(entity_type, {})}
        for k, p in PRESETS.items()
        if entity_type in p["maps"]
    ]


# ----------------------------------------------------------------------------- targets and mapping


def targets(actor: Actor | None, entity_type: str) -> dict[str, str]:
    """Fields a column may be mapped to: importable, visible and writable for this actor."""
    out = {}
    for f in schema.fields_for(actor, entity_type):
        if not f.importable or f.read_only or f.type == schema.TAGS:
            continue
        if not f.editable and f.key != "pipeline":
            continue
        out[f.key] = f"{f.label} (custom)" if f.custom else f.label
    return out


def _normalise_target(target: str) -> str:
    target = TARGET_ALIASES.get(target, target)
    if target.startswith("custom.") and not target.startswith("custom_data."):
        target = "custom_data." + target[7:]
    return target


def suggest(actor: Actor | None, entity_type: str, headers: Iterable[str], *, preset: str | None = None) -> dict:
    allowed = targets(actor, entity_type)
    mapping: dict[str, str] = {}
    used: set[str] = set()
    preset_map = PRESETS.get(preset or "", {}).get("maps", {}).get(entity_type, {})
    by_label = {label.lower().removesuffix(" (custom)"): key for key, label in allowed.items()}
    by_key = {key.lower(): key for key in allowed}
    by_key.update({key.removeprefix("custom_data.").lower(): key for key in allowed if key.startswith("custom_data.")})
    aliases = {
        "firstname": "first_name",
        "lastname": "last_name",
        "e-mail": "email",
        "mail": "email",
        "telephone": "phone",
        "mobile": "phone",
        "title": "job_title",
        "company name": "company" if entity_type != "company" else "name",
        "company_name": "company" if entity_type != "company" else "name",
        "organisation": "company",
        "organization": "company",
        "url": "website",
        "price": "unit_price",
        "code": "sku",
        "tax": "tax_rate",
        "value": "amount",
        "close date": "expected_close_date",
    }
    for header in headers:
        h = header.strip().lower()
        candidate = (
            preset_map.get(header)
            or by_key.get(h)
            or by_key.get(h.replace(" ", "_"))
            or by_label.get(h)
            or aliases.get(h)
        )
        if candidate and candidate in allowed and candidate not in used:
            mapping[header] = candidate
            used.add(candidate)
    return mapping


def validate_mapping(actor: Actor | None, entity_type: str, headers: list[str], mapping: Any) -> dict[str, str]:
    if not isinstance(mapping, dict) or not mapping:
        raise ValidationError({"mapping": "Map at least one column."})
    allowed = targets(actor, entity_type)
    cleaned: dict[str, str] = {}
    seen: set[str] = set()
    for header, raw_target in mapping.items():
        if header not in headers:
            raise ValidationError({"mapping": f"Unknown column '{str(header)[:60]}'."})
        if not raw_target:
            continue
        target = _normalise_target(str(raw_target))
        if target not in allowed:
            raise ValidationError({"mapping": f"'{str(raw_target)[:60]}' is not an importable field."})
        if target in seen:
            raise ValidationError({"mapping": f"'{target}' is mapped twice."})
        seen.add(target)
        cleaned[header] = target
    if not cleaned:
        raise ValidationError({"mapping": "Map at least one column."})
    return cleaned


def clean_options(options: Any) -> dict[str, Any]:
    opts = options if isinstance(options, dict) else {}
    dedupe = opts.get("dedupe", "create")
    if dedupe not in DEDUPE_MODES:
        raise ValidationError({"options": f"dedupe must be one of {', '.join(DEDUPE_MODES)}."})
    return {"create_companies": bool(opts.get("create_companies", True)), "dedupe": dedupe}


# ----------------------------------------------------------------------------- row -> payload


class RowError(Exception):
    def __init__(self, errors: list[dict[str, str]]):
        super().__init__("row error")
        self.errors = errors


def _bool(raw: str) -> bool:
    v = raw.strip().lower()
    if v in {"true", "yes", "y", "1"}:
        return True
    if v in {"false", "no", "n", "0"}:
        return False
    raise ValidationError("Expected yes/no.")


def _date(raw: str) -> dt.date:
    v = raw.strip()
    for parse in (dt.date.fromisoformat, lambda x: dt.datetime.fromisoformat(x).date()):
        try:
            return parse(v)
        except ValueError:
            continue
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d %b %Y", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    raise ValidationError("Expected a date (YYYY-MM-DD).")


@dataclass
class Resolver:
    """Looks up records named in a row (company by name, contact by email, pipeline and stage by name),
    within the requester's view scope. Creates companies on demand when the import allows it."""

    actor: Actor
    create_companies: bool
    dry_run: bool = False
    companies: dict[str, Any] = field(default_factory=dict)
    created: list[Any] = field(default_factory=list)

    def company(self, name: str) -> Any:
        from apps.companies.models import Company
        from apps.core import validators

        name = validators.clean_text(name, max_length=160)
        if not name:
            return None
        key = name.lower()
        if key in self.companies:
            return self.companies[key]
        found = scope(
            self.actor, "companies.view", Company.objects.filter(name__iexact=name, archived_at__isnull=True)
        ).first()
        if found is None and self.create_companies and not self.dry_run and self.actor.has("companies.create"):
            from apps.companies.api import create_company

            found = create_company(self.actor, {"name": name})
            self.created.append(found)
        self.companies[key] = found
        return found

    def forget(self, mark: int) -> None:
        """Drop companies created after ``mark`` (their row's savepoint rolled back)."""
        gone = {id(c) for c in self.created[mark:]}
        if gone:
            self.companies = {k: v for k, v in self.companies.items() if id(v) not in gone}
            del self.created[mark:]

    def contact(self, email: str) -> Any:
        from apps.contacts.models import Contact

        email = email.strip()
        if not email:
            return None
        return scope(
            self.actor, "contacts.view", Contact.objects.filter(email__iexact=email, archived_at__isnull=True)
        ).first()

    def pipeline(self, name: str) -> Any:
        from apps.pipelines.models import Pipeline

        qs = scope(self.actor, "pipelines.view", Pipeline.objects.filter(archived_at__isnull=True))
        if not name.strip():
            return qs.filter(parent__isnull=True).order_by("-is_default", "position").first()
        found = qs.filter(name__iexact=name.strip()).first()
        if found is None:
            raise ValidationError(f"Unknown pipeline '{name[:60]}'.")
        return found

    def stage(self, pipeline: Any, name: str) -> Any:
        from apps.pipelines.models import PipelineStage

        if not name.strip():
            return None
        found = PipelineStage.objects.filter(
            pipeline=pipeline, archived_at__isnull=True, name__iexact=name.strip()
        ).first()
        if found is None:
            raise ValidationError(f"Unknown stage '{name[:60]}' in {pipeline.name}.")
        return found


def build_payload(
    entity_type: str, row: dict[str, str], mapping: dict[str, str], fields: dict[str, schema.FieldDef], res: Resolver
) -> tuple[dict[str, Any], dict[str, str]]:
    """Map one row to the module's write-serializer input. Returns (payload, raw values by field key)."""
    payload: dict[str, Any] = {}
    raw_by_key: dict[str, str] = {}
    custom: dict[str, Any] = {}
    errors: list[dict[str, str]] = []
    pipeline_name = stage_name = None
    for header, key in mapping.items():
        value = (row.get(header) or "").strip()
        raw_by_key[key] = value
        f = fields.get(key)
        if f is None:
            continue
        try:
            if f.custom:
                custom[f.custom_key] = value if value != "" else None
            elif key == "pipeline":
                pipeline_name = value
            elif f.type == schema.STAGE:
                stage_name = value
            elif value == "":
                continue
            elif f.type == schema.LOOKUP and f.lookup == "company":
                company = res.company(value)
                if company is None:
                    raise ValidationError(f"No company named '{value[:60]}'.")
                payload["company_id"] = company.pk
            elif f.type == schema.LOOKUP and f.lookup == "contact":
                contact = res.contact(value)
                if contact is None:
                    raise ValidationError(f"No contact with email '{value[:60]}'.")
                payload[f.write_key or f"{key}_id"] = contact.pk
            elif f.type in schema.NUMERIC_TYPES:
                payload[key] = csvsafe.parse_decimal(value)
                if f.type in {schema.INTEGER, schema.PERCENT} and key == "probability":
                    payload[key] = int(payload[key])
            elif f.type == schema.DATE:
                payload[key] = _date(value)
            elif f.type == schema.BOOLEAN:
                payload[key] = _bool(value)
            elif f.type == schema.CHOICE:
                payload[key] = value.lower() if value.lower() in f.choices else value
            else:
                payload[key] = value
        except ValidationError as exc:
            errors.append({"field": key, "message": _message(exc.detail)})
        except (TypeError, ValueError):
            errors.append({"field": key, "message": "Invalid value."})
    if entity_type == "deal":
        try:
            pipeline = res.pipeline(pipeline_name or "")
            if pipeline is None:
                raise ValidationError("Create a pipeline first.")
            payload["pipeline_id"] = pipeline.pk
            stage = res.stage(pipeline, stage_name or "")
            if stage is not None:
                payload["stage_id"] = stage.pk
        except ValidationError as exc:
            errors.append(
                {"field": "pipeline" if pipeline_name is not None else "stage", "message": _message(exc.detail)}
            )
    if custom:
        payload["custom_data"] = custom
    if errors:
        raise RowError(errors)
    return payload, raw_by_key


def _message(detail: Any) -> str:
    if isinstance(detail, dict):
        return _message(next(iter(detail.values()), ""))
    if isinstance(detail, list):
        return _message(detail[0]) if detail else ""
    return str(detail)[:200]


def flatten(detail: Any, prefix: str = "") -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if isinstance(detail, dict):
        for k, v in detail.items():
            out.extend(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
    elif isinstance(detail, list):
        for item in detail:
            out.extend(flatten(item, prefix))
    else:
        out.append({"field": prefix or "non_field_errors", "message": str(detail)[:200]})
    return out[:20]


# ----------------------------------------------------------------------------- dedupe


def find_duplicate(actor: Actor, entity_type: str, module: schema.ModuleDef, raw: dict[str, str], payload: dict) -> Any:
    """The existing record (in the actor's view scope) this row matches, by the module's dedupe keys."""
    binding = module.bind()
    model = binding.spec.model
    for keys in module.dedupe_keys:
        cond: dict[str, Any] = {}
        for key in keys:
            if key == "pipeline":
                if "pipeline_id" not in payload:
                    cond = {}
                    break
                cond["pipeline_id"] = payload["pipeline_id"]
                continue
            value = (raw.get(key) or "").strip()
            if not value:
                cond = {}
                break
            cond[f"{key}__iexact"] = value
        if not cond:
            continue
        match = (
            scope(actor, f"{module.module}.view", model.objects.filter(archived_at__isnull=True, **cond))
            .order_by("created_at")
            .first()
        )
        if match is not None:
            return match
    return None


# ----------------------------------------------------------------------------- preview (dry run)


def preview(job: ImportJob, actor: Actor) -> dict[str, Any]:
    """Validate every row without writing anything: what would be created, updated, skipped and refused,
    and whether the plan's record limit would stop the import (and at which row)."""
    from apps.customfields.service import cached_definitions

    module = schema.get(job.entity_type)
    binding = module.bind()
    fields = schema.field_map(actor, job.entity_type)
    dedupe = job.options.get("dedupe", "create")
    res = Resolver(actor, create_companies=False, dry_run=True)
    counts = {"create": 0, "update": 0, "skip": 0, "fail": 0}
    errors: list[dict[str, Any]] = []
    new_companies: set[str] = set()
    raw_file = storage.read(job.storage_key)
    ent = entitlements.resolve(actor.organization)
    limit = ent.limit("records")
    used = entitlements.usage(actor.organization, "records")
    capacity = None if limit is None else max(0, limit - used)
    stop_row = None
    with cached_definitions():
        for row_no, row in csvsafe.iter_rows(raw_file, job.headers):
            try:
                payload, raw = build_payload(job.entity_type, row, job.mapping, fields, res)
            except RowError as exc:
                counts["fail"] += 1
                if len(errors) < MAX_IMPORT_ERRORS_STORED:
                    errors.append({"row": row_no, "errors": exc.errors})
                continue
            match = find_duplicate(actor, job.entity_type, module, raw, payload) if dedupe != "create" else None
            ser = binding.write_serializer(
                match if match is not None and dedupe == "update" else None,
                data=payload,
                partial=match is not None and dedupe == "update",
                context={"actor": actor},
            )
            if match is not None and dedupe == "skip":
                counts["skip"] += 1
                continue
            if not ser.is_valid():
                counts["fail"] += 1
                if len(errors) < MAX_IMPORT_ERRORS_STORED:
                    errors.append({"row": row_no, "errors": flatten(ser.errors)})
                continue
            if match is not None:
                counts["update"] += 1
                continue
            counts["create"] += 1
            company_name = raw.get("company") if job.entity_type in {"contact", "deal"} else None
            if company_name and res.company(company_name) is None and job.options.get("create_companies", True):
                new_companies.add(company_name.lower())
            needed = counts["create"] + len(new_companies)
            if capacity is not None and stop_row is None and needed > capacity:
                stop_row = row_no
    result: dict[str, Any] = {
        "rows_checked": sum(counts.values()),
        "would_create": counts["create"],
        "would_update": counts["update"],
        "would_skip": counts["skip"],
        "would_fail": counts["fail"],
        "companies_to_create": len(new_companies),
        "errors": errors,
        "limit": None,
    }
    if stop_row is not None:
        upgrade = entitlements._limit_upgrade(ent, "records", used=used, amount=counts["create"])
        result["limit"] = {
            "stops_at_row": stop_row,
            "capacity": capacity,
            "message": f"Your plan has room for {capacity} more records; the import would stop at row {stop_row}.",
            "upgrade": upgrade,
        }
    return result


# ----------------------------------------------------------------------------- commit


@dataclass
class _State:
    processed: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0
    errors: list[dict[str, Any]] = field(default_factory=list)
    stop: dict[str, Any] = field(default_factory=dict)

    def copy(self) -> _State:
        return _State(
            self.processed, self.created, self.updated, self.skipped, self.failed, list(self.errors), dict(self.stop)
        )

    def error(self, row_no: int, errs: list[dict[str, str]]) -> None:
        self.failed += 1
        if len(self.errors) < MAX_IMPORT_ERRORS_STORED:
            self.errors.append({"row": row_no, "errors": errs})


def _batches(rows: Iterable, size: int):
    batch = []
    for item in rows:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def process(job: ImportJob, actor: Actor) -> ImportJob:
    """Run one import to completion (or to the plan limit), committing as it goes. Safe to call again
    after a crash: it resumes after ``checkpoint_row``."""
    module = schema.get(job.entity_type)
    check(actor, f"{module.module}.import", job)
    if job.requested_by_id != actor.membership.pk:
        raise PermissionDenied(code="permission_denied")
    with tenant_atomic():
        started = job.started_at or timezone.now()
        ImportJob.objects.filter(pk=job.pk).update(
            status=JobStatus.RUNNING, started_at=started, attempts=F("attempts") + 1, updated_at=timezone.now()
        )
        job.refresh_from_db()
    dashboard_cache.invalidate(job.organization_id)
    raw_file = storage.read(job.storage_key)
    resume_after = job.checkpoint_row
    state = _State(
        processed=job.processed_rows,
        created=job.created_rows,
        updated=job.updated_rows,
        skipped=job.skipped_rows,
        failed=job.error_rows,
        errors=list(job.errors or []),
    )
    res = Resolver(actor, create_companies=bool(job.options.get("create_companies", True)))
    pending = ((n, row) for n, row in csvsafe.iter_rows(raw_file, job.headers) if n > resume_after)
    for batch in _batches(pending, max(1, settings.IMPORT_BATCH_SIZE)):
        if _run_batch(job, actor, module, batch, state=state, res=res):
            break
    final = JobStatus.STOPPED if state.stop else JobStatus.COMPLETED
    with tenant_atomic():
        ImportJob.objects.filter(pk=job.pk).update(
            processed_rows=state.processed,
            created_rows=state.created,
            updated_rows=state.updated,
            skipped_rows=state.skipped,
            error_rows=state.failed,
            errors=state.errors,
            stop=state.stop,
            status=final,
            finished_at=timezone.now(),
            updated_at=timezone.now(),
        )
        audit.record(
            "imports.stopped_at_limit" if state.stop else "imports.completed",
            user=actor.user,
            resource=job,
            metadata={
                "entity_type": job.entity_type,
                "created": state.created,
                "updated": state.updated,
                "skipped": state.skipped,
                "errors": state.failed,
                "resumed_from_row": resume_after,
                **({"stopped_at_row": state.stop.get("row")} if state.stop else {}),
            },
        )
    storage.delete(job.storage_key)
    job.refresh_from_db()
    return job


def _row_errors(exc: Exception) -> list[dict[str, str]]:
    if isinstance(exc, RowError):
        return exc.errors
    if isinstance(exc, ValidationError):
        return flatten(exc.detail)
    return [{"field": "non_field_errors", "message": str(getattr(exc, "message", exc))[:200]}]


def _snapshot(binding: schema.Binding, obj: Any, keys: Iterable[str]) -> dict[str, Any]:
    """The current values of ``keys`` (write-serializer keys) on ``obj``, JSON-ready, for a rollback."""
    out: dict[str, Any] = {}
    for key in keys:
        if key == "custom_data":
            out[key] = dict(obj.custom_data or {})
        elif key.endswith("_id") and hasattr(obj, key):
            value = getattr(obj, key)
            out[key] = str(value) if value is not None else None
        else:
            value = getattr(obj, key, None)
            out[key] = schema.to_json(value)
    return out


def _run_batch(
    job: ImportJob, actor: Actor, module: schema.ModuleDef, batch: list, *, state: _State, res: Resolver
) -> bool:
    """One transaction: this batch's rows, their ImportRow references and the checkpoint. Returns True
    when the plan's record limit stopped the import inside this batch."""
    from apps.customfields.service import cached_definitions

    local = state.copy()
    binding = module.bind()
    fields = schema.field_map(actor, job.entity_type)
    dedupe = job.options.get("dedupe", "create")
    companies_before, created_before = dict(res.companies), len(res.created)
    last_row = batch[-1][0]
    try:
        with tenant_atomic(), cached_definitions():
            for row_no, row in batch:
                mark = len(res.created)
                try:
                    with transaction.atomic(), audit.annotated(import_job_id=str(job.pk), import_row=row_no):
                        # savepoint: one bad row, not one bad batch
                        outcome = _import_row(job, actor, module, binding, fields, dedupe, row_no, row, res)
                except entitlements.LimitReached as exc:
                    # Stop here, cleanly: the rows before this one commit with this batch; this row and
                    # everything after it are not attempted. The checkpoint says exactly where it stopped.
                    res.forget(mark)
                    last_row = row_no - 1
                    local.stop = {"row": row_no, "message": exc.message, "upgrade": (exc.extra or {}).get("upgrade")}
                    break
                except (RowError, ValidationError, DomainError, PermissionDenied) as exc:
                    # Companies created for this row went with its savepoint: forget them.
                    res.forget(mark)
                    local.processed += 1
                    local.error(row_no, _row_errors(exc))
                    continue
                local.processed += 1
                setattr(local, outcome, getattr(local, outcome) + 1)
            ImportJob.objects.filter(pk=job.pk).update(
                processed_rows=local.processed,
                created_rows=local.created,
                updated_rows=local.updated,
                skipped_rows=local.skipped,
                error_rows=local.failed,
                errors=local.errors,
                checkpoint_row=last_row,
                stop=local.stop,
                updated_at=timezone.now(),
            )
    except Exception:
        res.companies = companies_before
        del res.created[created_before:]
        log.exception("importexport.batch_failed", job_id=str(job.pk), first_row=batch[0][0], last_row=last_row)
        raise
    state.processed, state.created, state.updated = local.processed, local.created, local.updated
    state.skipped, state.failed, state.errors, state.stop = local.skipped, local.failed, local.errors, local.stop
    return bool(local.stop)


def _import_row(
    job: ImportJob,
    actor: Actor,
    module: schema.ModuleDef,
    binding: schema.Binding,
    fields: dict[str, schema.FieldDef],
    dedupe: str,
    row_no: int,
    row: dict[str, str],
    res: Resolver,
) -> str:
    """Create, update or skip one row. Returns the counter to bump: created / updated / skipped."""
    created_before = len(res.created)
    payload, raw = build_payload(job.entity_type, row, job.mapping, fields, res)
    for company in res.created[created_before:]:  # companies created for this row roll back with it
        ImportRow.objects.create(
            job=job,
            row_number=row_no,
            entity_type="company",
            entity_id=company.pk,
            action=ImportRow.Action.CREATED,
            after_version=company.version,
        )
    match = find_duplicate(actor, job.entity_type, module, raw, payload) if dedupe != "create" else None
    if match is not None and dedupe == "skip":
        return "skipped"
    if match is not None:
        ser = binding.write_serializer(match, data=payload, partial=True, context={"actor": actor})
        ser.is_valid(raise_exception=True)
        data = dict(ser.validated_data)
        stage = data.pop("stage", None)
        data.pop("pipeline", None)
        keys = [k for k in payload if k not in {"stage_id", "pipeline_id"}]
        before = _snapshot(binding, match, keys)
        if stage is not None and job.entity_type == "deal" and stage.pk != match.stage_id:
            from apps.deals.models import DealStageHistory
            from apps.deals.services import move_stage

            before["stage_id"] = str(match.stage_id)
            match = move_stage(
                actor,
                match.pk,
                stage_id=stage.pk,
                expected_version=match.version,
                source=DealStageHistory.Source.IMPORT,
            )
        obj = binding.update(actor, match, data, expected_version=match.version) if data else match
        ImportRow.objects.create(
            job=job,
            row_number=row_no,
            entity_type=job.entity_type,
            entity_id=obj.pk,
            action=ImportRow.Action.UPDATED,
            before=before,
            after_version=obj.version,
        )
        return "updated"
    ser = binding.write_serializer(data=payload, context={"actor": actor})
    ser.is_valid(raise_exception=True)
    obj = binding.create(actor, dict(ser.validated_data), request=None)
    ImportRow.objects.create(
        job=job,
        row_number=row_no,
        entity_type=job.entity_type,
        entity_id=obj.pk,
        action=ImportRow.Action.CREATED,
        after_version=obj.version,
    )
    return "created"


# ----------------------------------------------------------------------------- rollback

ROLLBACK_STATUSES = (JobStatus.COMPLETED, JobStatus.STOPPED, JobStatus.FAILED)
# Rows the import itself creates alongside a record; they do not make the record "in use".
_OWN_DEPENDENTS = {"DealStageHistory", "LifecycleHistory", "ImportRow"}


def _in_use(obj: Any) -> str | None:
    """Why ``obj`` cannot be deleted without touching someone else's data, or None."""
    from apps.files.models import FileAttachment
    from apps.notes.models import Note

    entity_type = schema_entity(obj)
    if Note.objects.filter(entity_type=entity_type, entity_id=obj.pk).exists():
        return "has_notes"
    if FileAttachment.objects.filter(entity_type=entity_type, entity_id=obj.pk).exists():
        return "has_files"
    for rel in obj._meta.related_objects:
        if rel.related_model.__name__ in _OWN_DEPENDENTS or (not rel.one_to_many and not rel.one_to_one):
            continue
        manager = rel.related_model._default_manager
        if manager.filter(**{rel.field.name: obj}).exists():
            return f"linked_{rel.related_model.__name__.lower()}"
    return None


def schema_entity(obj: Any) -> str:
    for module in schema.modules():
        if isinstance(obj, module.bind().spec.model):
            return module.entity_type
    raise ValueError(type(obj).__name__)


def start_rollback(actor: Actor, job: ImportJob, *, request: Any = None) -> ImportJob:
    module = schema.get(job.entity_type)
    check(actor, f"{module.module}.import", job)
    if job.requested_by_id != actor.membership.pk:
        raise PermissionDenied(code="permission_denied")
    if job.status not in ROLLBACK_STATUSES:
        raise DomainError("Only a finished import can be rolled back.", code="import_not_finished", status_code=409)
    if job.rolled_back_at is not None:
        raise DomainError("This import was already rolled back.", code="import_rolled_back", status_code=409)
    with transaction.atomic():
        updated = ImportJob.objects.filter(pk=job.pk, status__in=ROLLBACK_STATUSES).update(
            status=JobStatus.ROLLING_BACK, updated_at=timezone.now()
        )
        if updated != 1:
            raise ConflictError("The import changed meanwhile. Reload.", code="import_state_changed")
        audit.record("imports.rollback_started", request=request, user=actor.user, resource=job)
    job.refresh_from_db()
    return job


def rollback(job: ImportJob, actor: Actor) -> ImportJob:
    """Undo an import, newest row first, in batches. Conflicts are reported, never overwritten."""
    module = schema.get(job.entity_type)
    check(actor, f"{module.module}.import", job)
    summary = {"deleted": 0, "reverted": 0, "missing": 0, "conflicts": [], **(job.rollback or {})}
    summary["conflicts"] = list(summary.get("conflicts") or [])
    refs = list(
        ImportRow.objects.filter(job=job, rolled_back=False)
        .order_by("-row_number", "-created_at")
        .values_list("pk", flat=True)
    )
    size = max(1, settings.IMPORT_BATCH_SIZE)
    for start in range(0, len(refs), size):
        chunk = refs[start : start + size]
        with tenant_atomic(), audit.batched():
            released = 0
            for ref in ImportRow.objects.filter(pk__in=chunk).order_by("-row_number", "-created_at"):
                outcome = _rollback_one(actor, job, ref)
                ref.rolled_back = True
                ref.save(update_fields=["rolled_back", "updated_at"])
                if outcome == "deleted":
                    summary["deleted"] += 1
                    released += 1
                elif outcome == "reverted":
                    summary["reverted"] += 1
                elif outcome == "missing":
                    summary["missing"] += 1
                elif len(summary["conflicts"]) < MAX_IMPORT_ERRORS_STORED:
                    summary["conflicts"].append(
                        {
                            "row": ref.row_number,
                            "entity_type": ref.entity_type,
                            "entity_id": str(ref.entity_id),
                            "reason": outcome,
                        }
                    )
            if released:
                # The deleted records were active, so each held a slot of the plan's record limit.
                entitlements.release(actor.organization, "records", released)
            ImportJob.objects.filter(pk=job.pk).update(rollback=summary, updated_at=timezone.now())
    summary["conflict_count"] = len(summary["conflicts"])
    with tenant_atomic():
        ImportJob.objects.filter(pk=job.pk).update(
            status=JobStatus.ROLLED_BACK, rollback=summary, rolled_back_at=timezone.now(), updated_at=timezone.now()
        )
        audit.record(
            "imports.rollback_completed",
            user=actor.user,
            resource=job,
            metadata={k: v for k, v in summary.items() if k != "conflicts"},
        )
    dashboard_cache.invalidate(job.organization_id)
    job.refresh_from_db()
    return job


def _rollback_one(actor: Actor, job: ImportJob, ref: ImportRow) -> str:
    """Undo one row. Returns deleted / reverted / missing, or the conflict reason."""
    module = schema.get(ref.entity_type)
    binding = module.bind()
    obj = binding.spec.model.objects.filter(pk=ref.entity_id).first()
    if obj is None:
        return "missing"
    if obj.version != ref.after_version:
        return "changed_since_import"
    try:
        with transaction.atomic():
            if ref.action == ImportRow.Action.CREATED:
                check(actor, f"{module.module}.delete", obj)
                if obj.archived_at is not None:
                    return "archived_since_import"
                reason = _in_use(obj)
                if reason:
                    return reason
                entity_id = obj.pk
                publish(
                    RecordChanged(
                        organization_id=obj.organization_id,
                        entity_type=ref.entity_type,
                        entity_ids=(entity_id,),
                        change="rolled_back",
                        owner_id=obj.owner_id,
                    )
                )
                from apps.tagging.models import TaggedItem

                TaggedItem.objects.filter(entity_type=ref.entity_type, entity_id=entity_id).delete()
                obj.delete()
                audit.record(
                    "imports.rolled_back",
                    user=actor.user,
                    resource_type=ref.entity_type,
                    resource_id=entity_id,
                    metadata={"job_id": str(job.pk), "row": ref.row_number, "action": "deleted"},
                )
                return "deleted"
            data = _revert_data(actor, binding, obj, ref.before)
            stage_id = data.pop("stage_id", None)
            if data:
                obj = binding.update(actor, obj, data, expected_version=obj.version)
            if stage_id and ref.entity_type == "deal" and str(obj.stage_id) != stage_id:
                from apps.deals.models import DealStageHistory
                from apps.deals.services import move_stage

                move_stage(
                    actor,
                    obj.pk,
                    stage_id=uuid.UUID(stage_id),
                    expected_version=obj.version,
                    source=DealStageHistory.Source.IMPORT,
                )
            audit.record(
                "imports.rolled_back",
                user=actor.user,
                resource_type=ref.entity_type,
                resource_id=obj.pk,
                metadata={
                    "job_id": str(job.pk),
                    "row": ref.row_number,
                    "action": "reverted",
                    "fields": sorted(ref.before),
                },
            )
            return "reverted"
    except ConflictError:
        return "changed_since_import"
    except (PermissionDenied, ValidationError, DomainError):
        return "not_permitted"


def _revert_data(actor: Actor, binding: schema.Binding, obj: Any, before: dict[str, Any]) -> dict[str, Any]:
    """Turn stored before-values back into validated write data (foreign keys become instances)."""
    stage_id = before.get("stage_id")
    payload = {k: v for k, v in before.items() if k != "stage_id"}
    data: dict[str, Any] = {}
    if payload:
        ser = binding.write_serializer(obj, data=payload, partial=True, context={"actor": actor})
        ser.is_valid(raise_exception=True)
        data = dict(ser.validated_data)
    if stage_id:
        data["stage_id"] = stage_id
    return data
