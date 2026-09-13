"""Allowlisted filtering, sorting and text search for list endpoints.

Every list view declares a ``FilterSet``: which query parameters are accepted, how each maps onto the
ORM, and which columns may be sorted. Unknown parameters and unknown sort keys answer 400, never
"ignore silently", so a typo cannot widen a result set and an attacker cannot probe arbitrary columns.
All lookups are ORM keyword arguments (parameterised SQL); user input never reaches a query string.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db.models import Q, QuerySet
from rest_framework.exceptions import ValidationError

MAX_SEARCH_LENGTH = 200
MAX_IN_VALUES = 50
RESERVED_PARAMS = frozenset({"cursor", "limit", "sort", "q", "expand", "format", "archived"})

ME = "me"


@dataclass(frozen=True)
class Filter:
    """One accepted query parameter.

    ``kind`` decides parsing: ``uuid``, ``uuid_list``, ``text`` (icontains), ``exact``, ``choice``,
    ``bool``, ``isnull``, ``has`` (present), ``date_from``/``date_to``, ``decimal_min``/``decimal_max``, ``owner``
    (uuid or "me"). ``lookup`` is the ORM path.
    """

    kind: str
    lookup: str
    choices: tuple[str, ...] = ()
    max_length: int = 120


@dataclass
class FilterSet:
    filters: Mapping[str, Filter]
    sort_fields: Mapping[str, str]  # public name -> ORM field
    default_sort: str = "-created_at"
    search_fields: tuple[str, ...] = ()
    custom_field_entity: str | None = None
    extra: dict[str, Callable[[QuerySet, str, Any], QuerySet]] = field(default_factory=dict)

    def apply(self, qs: QuerySet, params: Mapping[str, str], *, actor: Any = None) -> tuple[QuerySet, tuple[str, ...]]:
        errors: dict[str, str] = {}
        custom_filters: dict[str, str] = {}
        for raw_key, raw_value in params.items():
            if raw_key in RESERVED_PARAMS:
                continue
            key = raw_key
            if key.startswith("filter[") and key.endswith("]"):
                key = key[7:-1]
            if key.startswith("custom."):
                if self.custom_field_entity is None:
                    errors[raw_key] = "Custom field filters are not supported here."
                else:
                    custom_filters[key[7:]] = raw_value
                continue
            spec = self.filters.get(key)
            if spec is None:
                if key in self.extra:
                    qs = self.extra[key](qs, key, raw_value)
                    continue
                errors[raw_key] = "Unknown filter."
                continue
            try:
                qs = _apply_one(qs, spec, raw_value, actor)
            except ValidationError as exc:
                errors[raw_key] = _first_message(exc)
        if custom_filters:
            from apps.customfields import service as customfields

            try:
                qs = customfields.apply_filters(qs, self.custom_field_entity or "", custom_filters)
            except ValidationError as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {"custom": exc.detail}
                errors.update({f"custom.{k}": str(v) for k, v in detail.items()})
        q = (params.get("q") or "").strip()
        if q:
            if len(q) > MAX_SEARCH_LENGTH:
                errors["q"] = f"Search text is limited to {MAX_SEARCH_LENGTH} characters."
            elif self.search_fields:
                cond = Q()
                for f in self.search_fields:
                    cond |= Q(**{f"{f}__icontains": q})
                qs = qs.filter(cond)
        ordering = self.resolve_sort(params.get("sort"), errors)
        if errors:
            raise ValidationError(errors)
        return qs, ordering

    def resolve_sort(self, raw: str | None, errors: dict[str, str]) -> tuple[str, ...]:
        raw = (raw or self.default_sort).strip()
        desc = raw.startswith("-")
        key = raw[1:] if desc else raw
        column = self.sort_fields.get(key)
        if column is None:
            errors["sort"] = f"Unknown sort key. Allowed: {', '.join(sorted(self.sort_fields))}."
            return ("-created_at", "-id")
        return (f"-{column}" if desc else column, "-id" if desc else "id")


def _first_message(exc: ValidationError) -> str:
    detail = exc.detail
    if isinstance(detail, list) and detail:
        return str(detail[0])
    if isinstance(detail, dict) and detail:
        return str(next(iter(detail.values())))
    return str(detail)


def _apply_one(qs: QuerySet, spec: Filter, raw: str, actor: Any) -> QuerySet:
    raw = raw.strip()
    if len(raw) > max(spec.max_length, 512):
        raise ValidationError("Value too long.")
    kind = spec.kind
    if kind == "uuid":
        return qs.filter(**{spec.lookup: _uuid(raw)})
    if kind == "uuid_list":
        ids = [_uuid(v) for v in raw.split(",") if v.strip()][:MAX_IN_VALUES]
        return qs.filter(**{f"{spec.lookup}__in": ids})
    if kind == "owner":
        if raw == ME:
            if actor is None:
                raise ValidationError("No active membership.")
            return qs.filter(**{spec.lookup: actor.membership.id})
        return qs.filter(**{spec.lookup: _uuid(raw)})
    if kind == "text":
        if len(raw) > spec.max_length:
            raise ValidationError("Value too long.")
        return qs.filter(**{f"{spec.lookup}__icontains": raw})
    if kind == "exact":
        if len(raw) > spec.max_length:
            raise ValidationError("Value too long.")
        return qs.filter(**{spec.lookup: raw})
    if kind == "choice":
        values = [v for v in raw.split(",") if v]
        if not values or any(v not in spec.choices for v in values):
            raise ValidationError(f"Allowed values: {', '.join(spec.choices)}.")
        return qs.filter(**{f"{spec.lookup}__in": values})
    if kind == "bool":
        return qs.filter(**{spec.lookup: _bool(raw)})
    if kind == "isnull":
        return qs.filter(**{f"{spec.lookup}__isnull": _bool(raw)})
    if kind == "has":
        return qs.filter(**{f"{spec.lookup}__isnull": not _bool(raw)})
    if kind in {"date_from", "date_to"}:
        day = _date(raw)
        suffix = "gte" if kind == "date_from" else "lte"
        return qs.filter(**{f"{spec.lookup}__{suffix}": day})
    if kind in {"decimal_min", "decimal_max"}:
        number = _decimal(raw)
        suffix = "gte" if kind == "decimal_min" else "lte"
        return qs.filter(**{f"{spec.lookup}__{suffix}": number})
    raise ValidationError("Unsupported filter.")  # pragma: no cover - programming error


def _bool(raw: str) -> bool:
    if raw.lower() in {"true", "1", "yes"}:
        return True
    if raw.lower() in {"false", "0", "no"}:
        return False
    raise ValidationError("Expected true or false.")


def _uuid(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw.strip())
    except ValueError as exc:
        raise ValidationError("Expected a UUID.") from exc


def _date(raw: str) -> dt.date:
    try:
        return dt.date.fromisoformat(raw)
    except ValueError as exc:
        raise ValidationError("Expected an ISO date (YYYY-MM-DD).") from exc


def _decimal(raw: str) -> Decimal:
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:
        raise ValidationError("Expected a number.") from exc
    if not value.is_finite():
        raise ValidationError("Expected a finite number.")
    return value


def parse_uuid_list(values: Iterable[Any], *, max_items: int) -> list[uuid.UUID]:
    if not isinstance(values, list | tuple):
        raise ValidationError({"ids": "Expected a list of ids."})
    out: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for v in values:
        parsed = _uuid(str(v))
        if parsed in seen:
            continue
        seen.add(parsed)
        out.append(parsed)
        if len(out) > max_items:
            raise ValidationError({"ids": f"At most {max_items} ids per request."})
    if not out:
        raise ValidationError({"ids": "At least one id is required."})
    return out
