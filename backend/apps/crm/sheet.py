"""Sheet view writes: many cell edits in one request, applied row by row through each module's own update.

Guarantees, per the Milestone 2 spec:
- every row is written through the module's normal update path (field rules, custom-field validation,
  owner rules, versioning), so each changed record gets its own audit event and its own domain event;
  the audit rows are inserted together (``audit.batched``) for throughput;
- a cell aimed at a field the actor cannot see, or that does not exist, is refused as
  ``field_not_editable`` (the same answer for both, so the grid cannot probe for hidden fields); a
  read-only field is refused as ``field_read_only``. These checks run on the server whatever the client did;
- each cell is validated on its own first, so one bad value is reported against its cell while the
  row's other edits still save;
- each row carries the ``version`` the client saw: a row changed by someone else since then is
  reported as a ``conflict`` with its current values, and nothing of that row is written;
- a deal's ``stage`` cell is a stage move (``move_stage``: transition hook, history, won/lost rules).
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from django.db import transaction
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check, scope
from apps.core.exceptions import ConflictError, DomainError
from apps.crm import query, schema

MAX_ROWS = 500
MAX_CELLS = 5000


def _cell_error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _flatten(detail: Any) -> str:
    if isinstance(detail, dict):
        return _flatten(next(iter(detail.values()), ""))
    if isinstance(detail, list):
        return _flatten(detail[0]) if detail else ""
    return str(detail)


def _validate_cell(serializer_class, actor: Actor, obj: Any, f: schema.FieldDef, raw: Any) -> dict[str, Any]:
    """Validate one cell against the module's write serializer. Returns its validated data."""
    ser = serializer_class(obj, data=schema.write_payload(f, raw), partial=True, context={"actor": actor})
    if not ser.is_valid():
        raise ValidationError(_flatten(ser.errors))
    return dict(ser.validated_data)


def apply_edits(
    actor: Actor, entity_type: str, edits: Sequence[Mapping[str, Any]], *, request: Any = None
) -> dict[str, Any]:
    module = schema.get(entity_type)
    check(actor, f"{module.module}.update")
    if not isinstance(edits, list) or not edits:
        raise ValidationError({"rows": "Send at least one row."})
    if len(edits) > MAX_ROWS:
        raise ValidationError({"rows": f"At most {MAX_ROWS} rows per request."})
    if sum(len(e.get("values") or {}) for e in edits if isinstance(e, Mapping)) > MAX_CELLS:
        raise ValidationError({"rows": f"At most {MAX_CELLS} cells per request."})
    binding = module.bind()
    fields = schema.field_map(actor, entity_type)
    ids = []
    for e in edits:
        try:
            ids.append(uuid.UUID(str(e.get("id"))))
        except (TypeError, ValueError) as exc:
            raise ValidationError({"rows": "Every row needs a record id."}) from exc
    records = {
        o.pk: o
        for o in scope(actor, f"{module.module}.view", binding.queryset().filter(pk__in=ids, archived_at__isnull=True))
    }
    results: list[dict[str, Any]] = []
    saved = 0
    from apps.customfields.service import cached_definitions

    with transaction.atomic(), audit.batched(), cached_definitions():
        for edit, pk in zip(edits, ids, strict=True):
            result = _apply_row(actor, entity_type, binding, fields, records.get(pk), pk, edit, request=request)
            saved += result["status"] in {"saved", "partial"}
            results.append(result)
    return {
        "entity_type": entity_type,
        "saved": saved,
        "failed": len(results) - saved,
        "results": results,
    }


def _apply_row(
    actor: Actor,
    entity_type: str,
    binding: schema.Binding,
    fields: dict[str, schema.FieldDef],
    obj: Any,
    pk: uuid.UUID,
    edit: Mapping[str, Any],
    *,
    request: Any,
) -> dict[str, Any]:
    result: dict[str, Any] = {"id": str(pk), "status": "saved", "errors": {}}
    if obj is None:
        result.update(status="error", errors={"_row": _cell_error("not_found", "Record not found.")})
        return result
    values = edit.get("values")
    if not isinstance(values, Mapping) or not values:
        result.update(status="error", errors={"_row": _cell_error("no_changes", "No cells to save.")})
        return result
    version = edit.get("version")
    if not isinstance(version, int) or version != obj.version:
        return _conflict(result, entity_type, obj, fields, values)

    # 1. Cells the actor may not touch at all, refused before any write.
    errors: dict[str, dict[str, str]] = {}
    writable: dict[str, schema.FieldDef] = {}
    for key in values:
        f = fields.get(key)
        if f is None or not f.editable:
            errors[key] = _cell_error("field_not_editable", "This field cannot be edited here.")
        elif f.read_only:
            errors[key] = _cell_error("field_read_only", "You can view this field but not change it.")
        else:
            writable[key] = f
    # 2. Each remaining cell validated on its own; failures are reported, the rest go ahead.
    data: dict[str, Any] = {}
    stage_id = None
    for key, f in writable.items():
        if entity_type == "deal" and f.type == schema.STAGE:
            raw = values[key]
            stage_id = raw.get("id") if isinstance(raw, Mapping) else raw
            continue
        try:
            cell = _validate_cell(binding.write_serializer, actor, obj, f, values[key])
        except ValidationError as exc:
            errors[key] = _cell_error("invalid", _flatten(exc.detail))
            continue
        if "custom_data" in cell and "custom_data" in data:
            # Several custom cells: each validated value merges into the one custom_data payload.
            data["custom_data"].update({k: v for k, v in cell["custom_data"].items()})
            cell.pop("custom_data")
        data.update(cell)
    if not data and stage_id is None:
        result.update(status="error", errors=errors)
        return result
    # 3. Write the row in its own savepoint: a refusal leaves the other rows' edits intact.
    try:
        with transaction.atomic(), audit.batched():
            if stage_id is not None:
                from apps.deals.services import move_stage

                obj = move_stage(actor, obj.pk, stage_id=stage_id, expected_version=obj.version, request=request)
            if data:
                obj = binding.update(actor, obj, data, expected_version=obj.version, request=request)
    except ConflictError:
        return _conflict(result, entity_type, binding.queryset().filter(pk=pk).first() or obj, fields, values)
    except PermissionDenied as exc:
        code = getattr(exc.detail, "code", None) or "permission_denied"
        message = str(exc.detail)
        blocked = [k for k in values if k in message] or ["_row"]
        for key in blocked:
            errors[key] = _cell_error(str(code), message)
        result.update(status="error", errors=errors)
        return result
    except ValidationError as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {"_row": exc.detail}
        for key, msg in detail.items():
            errors[_field_key(fields, str(key))] = _cell_error("invalid", _flatten(msg))
        result.update(status="error", errors=errors)
        return result
    except DomainError as exc:
        target = "amount" if exc.code == "amount_from_lines" else ("stage" if stage_id is not None else "_row")
        errors[target] = _cell_error(exc.code, exc.message)
        result.update(status="error", errors=errors)
        return result
    fresh = binding.queryset().filter(pk=pk).first() or obj
    result["version"] = fresh.version
    result["values"] = query.serialize_rows([fresh], entity_type, [fields[k] for k in values if k in fields])[0][
        "values"
    ]
    if errors:
        result["status"] = "partial"
        result["errors"] = errors
    return result


def _field_key(fields: dict[str, schema.FieldDef], key: str) -> str:
    """Map a write-serializer error key (``company_id``) back to the grid's field key (``company``)."""
    for f in fields.values():
        if key in {f.key, f.write_key, f"{f.key}_id"}:
            return f.key
    return key if key in fields else "_row"


def _conflict(
    result: dict[str, Any], entity_type: str, obj: Any, fields: dict[str, schema.FieldDef], values: Mapping
) -> dict[str, Any]:
    visible = [fields[k] for k in values if k in fields]
    current = query.serialize_rows([obj], entity_type, visible)[0]
    result.update(
        status="conflict",
        version=obj.version,
        values=current["values"],
        errors={"_row": _cell_error("version_conflict", "Someone else changed this record. Review and retry.")},
    )
    return result
