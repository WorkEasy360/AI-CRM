"""Reads behind the List, Sheet, Kanban, Calendar and Chart views, for any registered module.

Every function starts from the module's own base queryset, narrows it with ``authz.scope()`` (role
hierarchy, teams, restricted pipelines) and the module's ``FilterSet`` (which refuses filters and sorts on
fields the actor may not see), and reads values through ``apps.crm.schema`` (which leaves hidden fields
out). Nothing here is module-specific: a module added to the schema registry gets every view for free.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.db.models import Count, F, QuerySet, Sum
from rest_framework.exceptions import ValidationError

from apps.authz.actor import Actor
from apps.authz.service import check, scope
from apps.crm import schema

MAX_WINDOW = 500
MAX_GROUP_PAGE = 200
MAX_CALENDAR_ITEMS = 1000
MAX_CALENDAR_DAYS = 92
MAX_CHART_GROUPS = 50
# Query parameters the view endpoints use for themselves (everything else goes to the FilterSet).
VIEW_PARAMS = frozenset(
    {"offset", "limit", "columns", "group_by", "value", "per_group", "date_field", "from", "to", "measure", "field"}
)


def _filter_params(params: Mapping[str, str]) -> dict[str, str]:
    return {k: v for k, v in params.items() if k not in VIEW_PARAMS}


def base(actor: Actor, entity_type: str, params: Mapping[str, str]) -> tuple[schema.ModuleDef, QuerySet, tuple]:
    """Scoped, filtered, active (not archived) records of one module, plus the resolved ordering."""
    module = schema.get(entity_type)
    permission = f"{module.module}.view"
    check(actor, permission)
    binding = module.bind()
    qs = scope(actor, permission, binding.queryset().filter(archived_at__isnull=True))
    qs, ordering = binding.filterset.apply(qs, _filter_params(params), actor=actor)
    return module, qs, ordering


def _columns(actor: Actor, entity_type: str, raw: str | None, module: schema.ModuleDef) -> list[schema.FieldDef]:
    fields = schema.field_map(actor, entity_type)
    if raw:
        keys = [k for k in raw.split(",") if k]
        if len(keys) > 80:
            raise ValidationError({"columns": "At most 80 columns."})
        # Hidden columns are dropped rather than refused: a shared view may list a column this viewer
        # cannot see, and the view should still open for them without it.
        keys = [k for k in keys if k in fields]
    else:
        keys = [k for k in module.default_columns if k in fields]
    return [fields[k] for k in dict.fromkeys(keys)]


def _tags_map(entity_type: str, columns: list[schema.FieldDef], ids: list[Any]) -> dict | None:
    if not any(c.type == schema.TAGS for c in columns):
        return None
    from apps.tagging import service as tagging

    return tagging.tags_for(entity_type, ids)


def serialize_rows(
    objs: list[Any], entity_type: str, columns: list[schema.FieldDef], *, actor: Actor | None = None
) -> list[dict[str, Any]]:
    tags_map = _tags_map(entity_type, columns, [o.pk for o in objs])
    title_key = schema.get(entity_type).title_field
    rows = []
    for obj in objs:
        values = {c.key: schema.read_value(obj, c, tags_map=tags_map) for c in columns}
        rows.append(
            {
                "id": str(obj.pk),
                "version": getattr(obj, "version", None),
                "title": str(getattr(obj, title_key, "") or ""),
                "values": values,
            }
        )
    return rows


def window(qs: QuerySet, ordering: tuple, offset: int, limit: int) -> list[Any]:
    """Rows ``offset``..``offset+limit`` of the ordered set, in two steps.

    First only the primary keys of the window are selected: an OFFSET still produces every skipped row,
    and with the module's per-row annotations (open deals, next activity, ...) in the select list each
    skipped row would pay for them. Selecting bare keys keeps a deep window an index walk; the full rows
    (annotations and all) are then read for just the ``limit`` keys found.
    """
    ids = list(qs.order_by(*ordering).values_list("pk", flat=True)[offset : offset + limit])
    if not ids:
        return []
    by_id = {obj.pk: obj for obj in qs.filter(pk__in=ids)}
    return [by_id[pk] for pk in ids if pk in by_id]


def bounded_count(qs: QuerySet, cap: int) -> tuple[int, bool]:
    n = qs.order_by().values("pk")[: cap + 1].count()
    return min(n, cap), n <= cap


def rows(actor: Actor, entity_type: str, params: Mapping[str, str]) -> dict[str, Any]:
    """One window of rows for the Sheet (and List) view: ``offset`` + ``limit`` over the sorted set.

    The window is fetched with LIMIT/OFFSET over the module's ordered index, so the client never loads the
    set: a 1,000,000-record organization scrolls in windows of at most ``MAX_WINDOW`` rows.
    """
    module, qs, ordering = base(actor, entity_type, params)
    offset = _int(params.get("offset"), 0, 10_000_000, "offset")
    limit = _int(params.get("limit"), 100, MAX_WINDOW, "limit")
    columns = _columns(actor, entity_type, params.get("columns"), module)
    total, exact = bounded_count(qs, settings.SHEET_COUNT_CAP)
    objs = window(qs, ordering, offset, limit)
    return {
        "entity_type": entity_type,
        "offset": offset,
        "limit": limit,
        "total": total,
        "exact": exact,
        "columns": [c.describe() for c in columns],
        "rows": serialize_rows(objs, entity_type, columns, actor=actor),
    }


# ----------------------------------------------------------------------------- grouping (Kanban, Chart)


def _group_field(actor: Actor, entity_type: str, key: str | None) -> schema.FieldDef:
    f = schema.field_map(actor, entity_type).get(key or "")
    if f is None or not f.groupable:
        raise ValidationError({"group_by": "This field cannot be used to group records."})
    return f


def _group_column(f: schema.FieldDef) -> str:
    if f.custom:
        return f"custom_data__{f.custom_key}"
    if f.type in {schema.LOOKUP, schema.USER, schema.STAGE}:
        return f"{f.key}_id"
    return f.key


def _group_labels(f: schema.FieldDef, values: list[Any]) -> dict[Any, str]:
    """Display labels for group keys (member names, stage/pipeline names); choices label themselves."""
    ids = [v for v in values if v is not None]
    if f.type == schema.USER:
        from apps.accounts.models import Membership

        return {m.pk: m.user.display_name for m in Membership.objects.filter(pk__in=ids).select_related("user")}
    if f.type == schema.STAGE:
        from apps.pipelines.models import PipelineStage

        return {s.pk: s.name for s in PipelineStage.objects.filter(pk__in=ids)}
    if f.lookup == "pipeline":
        from apps.pipelines.models import Pipeline

        return {p.pk: p.name for p in Pipeline.objects.filter(pk__in=ids)}
    return {}


def _group_order(f: schema.FieldDef, present: list[Any]) -> list[Any]:
    """Choice fields keep their defined order (and show empty columns); others sort by key."""
    if f.type == schema.CHOICE and f.choices:
        extra = [v for v in present if v not in f.choices]
        return [*f.choices, *extra]
    if f.type == schema.BOOLEAN:
        return [True, False]
    return sorted(present, key=lambda v: (v is None, str(v)))


def groups(actor: Actor, entity_type: str, params: Mapping[str, str]) -> dict[str, Any]:
    """Generic Kanban: one column per value of a groupable field, with counts and the first cards."""
    module, qs, ordering = base(actor, entity_type, params)
    f = _group_field(actor, entity_type, params.get("group_by"))
    per_group = _int(params.get("per_group"), 50, MAX_GROUP_PAGE, "per_group")
    columns = _columns(actor, entity_type, params.get("columns"), module)
    col = _group_column(f)
    counts = {row[col]: row["n"] for row in qs.order_by().values(col).annotate(n=Count("pk"))}
    keys = _group_order(f, list(counts))
    labels = _group_labels(f, keys)
    out = []
    for key in keys[:MAX_CHART_GROUPS]:
        members = qs.filter(**({f"{col}__isnull": True} if key is None else {col: key}))
        objs = list(members.order_by(*ordering)[:per_group])
        out.append(
            {
                "value": schema.to_json(key),
                "label": labels.get(key) or ("(none)" if key in (None, "") else str(key)),
                "count": counts.get(key, 0),
                "rows": serialize_rows(objs, entity_type, columns, actor=actor),
                "has_more": counts.get(key, 0) > len(objs),
            }
        )
    return {
        "entity_type": entity_type,
        "group_by": f.describe(),
        "columns": [c.describe() for c in columns],
        "groups": out,
    }


def group_page(actor: Actor, entity_type: str, params: Mapping[str, str]) -> dict[str, Any]:
    """More cards of one generic Kanban column (``value`` = the column's key, "" for none)."""
    module, qs, ordering = base(actor, entity_type, params)
    f = _group_field(actor, entity_type, params.get("group_by"))
    col = _group_column(f)
    raw = params.get("value", "")
    offset = _int(params.get("offset"), 0, 1_000_000, "offset")
    limit = _int(params.get("limit"), 50, MAX_GROUP_PAGE, "limit")
    members = qs.filter(**{f"{col}__isnull": True}) if raw in ("", "null") else qs.filter(**{col: _coerce(f, raw)})
    columns = _columns(actor, entity_type, params.get("columns"), module)
    objs = list(members.order_by(*ordering)[offset : offset + limit + 1])
    return {
        "value": raw,
        "offset": offset,
        "rows": serialize_rows(objs[:limit], entity_type, columns, actor=actor),
        "has_more": len(objs) > limit,
    }


def _coerce(f: schema.FieldDef, raw: str) -> Any:
    if f.type == schema.BOOLEAN:
        return raw.lower() in {"true", "1"}
    if f.type in {schema.USER, schema.STAGE, schema.LOOKUP}:
        import uuid

        try:
            return uuid.UUID(raw)
        except ValueError as exc:
            raise ValidationError({"value": "Expected an id."}) from exc
    return raw


# ----------------------------------------------------------------------------- calendar


def calendar(actor: Actor, entity_type: str, params: Mapping[str, str]) -> dict[str, Any]:
    """Records placed on a calendar by one of their date fields (``date_field``) within ``from``..``to``."""
    module, qs, _ = base(actor, entity_type, params)
    f = schema.field_map(actor, entity_type).get(params.get("date_field", ""))
    if f is None or f.type not in schema.DATE_TYPES or f.custom:
        raise ValidationError({"date_field": "Choose a date field of this module."})
    try:
        start = dt.date.fromisoformat(params.get("from", ""))
        end = dt.date.fromisoformat(params.get("to", ""))
    except ValueError as exc:
        raise ValidationError({"from": "Provide from and to as ISO dates (YYYY-MM-DD)."}) from exc
    if end < start or (end - start).days > MAX_CALENDAR_DAYS:
        raise ValidationError({"to": f"The range must cover at most {MAX_CALENDAR_DAYS} days."})
    lookup = f.key if f.type == schema.DATE else f"{f.key}__date"
    columns = _columns(actor, entity_type, params.get("columns"), module)
    objs = list(
        qs.filter(**{f"{lookup}__gte": start, f"{lookup}__lte": end}).order_by(f.key, "pk")[:MAX_CALENDAR_ITEMS]
    )
    items = serialize_rows(objs, entity_type, columns, actor=actor)
    for obj, item in zip(objs, items, strict=True):
        item["date"] = schema.to_json(getattr(obj, f.key))
    return {
        "entity_type": entity_type,
        "date_field": f.key,
        "items": items,
        "truncated": len(objs) >= MAX_CALENDAR_ITEMS,
    }


# ----------------------------------------------------------------------------- chart


def chart(actor: Actor, entity_type: str, params: Mapping[str, str]) -> dict[str, Any]:
    """One grouped series: ``count`` of records, or ``sum`` of a numeric field, per value of ``group_by``."""
    _, qs, _ = base(actor, entity_type, params)
    f = _group_field(actor, entity_type, params.get("group_by"))
    col = _group_column(f)
    measure = params.get("measure", "count")
    if measure not in {"count", "sum"}:
        raise ValidationError({"measure": "Use count or sum."})
    summed: schema.FieldDef | None = None
    if measure == "sum":
        summed = schema.field_map(actor, entity_type).get(params.get("field", ""))
        if summed is None or summed.type not in schema.NUMERIC_TYPES or summed.custom:
            raise ValidationError({"field": "Choose a number or money field you can see."})
        column = summed.sort or summed.key  # money is summed in the base currency where one exists
        rows_ = qs.order_by().values(col).annotate(v=Sum(F(column)))
    else:
        rows_ = qs.order_by().values(col).annotate(v=Count("pk"))
    data = {r[col]: r["v"] for r in rows_}
    keys = [k for k in _group_order(f, list(data)) if k in data][:MAX_CHART_GROUPS]
    labels = _group_labels(f, keys)
    return {
        "entity_type": entity_type,
        "group_by": f.key,
        "measure": measure,
        "field": summed.key if summed else None,
        "series": [
            {
                "key": schema.to_json(k),
                "label": labels.get(k) or ("(none)" if k in (None, "") else str(k)),
                "value": str(Decimal(data[k] or 0)) if summed else int(data[k] or 0),
            }
            for k in keys
        ],
    }


def _int(raw: str | None, default: int, maximum: int, name: str) -> int:
    if raw in (None, ""):
        return default
    try:
        value = int(raw or 0)
    except (TypeError, ValueError) as exc:
        raise ValidationError({name: "Expected a whole number."}) from exc
    return max(0, min(value, maximum))
