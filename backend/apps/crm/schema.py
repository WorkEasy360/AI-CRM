"""Runtime module schema: what fields each CRM module has, described as data.

Every surface that works on "any module" (Sheet view, saved-view columns, the generic Kanban, calendar
and chart views, import targets, export columns, pipeline layouts, the field-permission editor) reads
this registry instead of a hard-coded field list. Each module registers its built-in fields from its
``AppConfig.ready()``; custom fields are appended at read time from ``apps.customfields``. Milestone 3
adds custom fields and custom modules by registering more of the same, with no change to the consumers.

Field permissions are applied here too: ``fields_for(actor, ...)`` leaves hidden fields out entirely and
marks read-only ones, so a consumer that only uses this module cannot show or write a restricted field.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Any

from rest_framework.exceptions import ValidationError

# Field types understood by every consumer (the frontend grid renders an editor per type).
TEXT, TEXTAREA, EMAIL, PHONE, URL = "text", "textarea", "email", "phone", "url"
INTEGER, NUMBER, MONEY, PERCENT = "integer", "number", "money", "percent"
DATE, DATETIME, BOOLEAN = "date", "datetime", "boolean"
CHOICE, MULTI_CHOICE = "choice", "multi_choice"
LOOKUP, USER, TAGS, STAGE = "lookup", "user", "tags", "stage"
FIELD_TYPES = frozenset(
    {TEXT, TEXTAREA, EMAIL, PHONE, URL, INTEGER, NUMBER, MONEY, PERCENT, DATE, DATETIME, BOOLEAN}
    | {CHOICE, MULTI_CHOICE, LOOKUP, USER, TAGS, STAGE}
)
NUMERIC_TYPES = frozenset({INTEGER, NUMBER, MONEY, PERCENT})
DATE_TYPES = frozenset({DATE, DATETIME})

_CUSTOM_TYPES = {
    "text": TEXT,
    "textarea": TEXTAREA,
    "integer": INTEGER,
    "number": NUMBER,
    "currency": MONEY,
    "percent": PERCENT,
    "date": DATE,
    "datetime": DATETIME,
    "checkbox": BOOLEAN,
    "dropdown": CHOICE,
    "multi_select": MULTI_CHOICE,
    "email": EMAIL,
    "phone": PHONE,
    "url": URL,
}


@dataclass(frozen=True)
class FieldDef:
    key: str  # API name; custom fields are "custom_data.<key>"
    label: str
    type: str
    editable: bool = True  # writable through the generic paths (Sheet, import, Kanban drag)
    required: bool = False
    sort: str | None = None  # ORM column when the field can be sorted on
    choices: tuple[str, ...] = ()
    lookup: str | None = None  # entity type a LOOKUP points at
    source: str | None = None  # dotted attribute path to read the value (defaults to ``key``)
    write_key: str | None = None  # write-serializer key (``company_id`` for ``company``)
    groupable: bool = False  # usable as a Kanban column / chart dimension
    importable: bool = True
    exportable: bool = True
    currency_field: str | None = None  # MONEY: the field holding its currency
    custom: bool = False
    read_only: bool = False  # set per actor by ``fields_for`` (field permissions)

    def __post_init__(self) -> None:
        if self.type not in FIELD_TYPES:
            raise ValueError(f"Unknown field type {self.type!r} for {self.key}")

    @property
    def custom_key(self) -> str:
        return self.key.removeprefix("custom_data.")

    def describe(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "editable": self.editable and not self.read_only,
            "read_only": self.read_only,
            "required": self.required,
            "sortable": self.sort is not None,
            "groupable": self.groupable,
            "choices": list(self.choices),
            "lookup": self.lookup,
            "custom": self.custom,
            "importable": self.importable,
            "currency_field": self.currency_field,
        }


@dataclass(frozen=True)
class Binding:
    """How the generic paths reach a module's own validation and lifecycle (lazy: no import cycles)."""

    spec: Any  # apps.crm.records.RecordSpec
    write_serializer: type
    filterset: Any  # apps.core.api.filters.FilterSet
    queryset: Callable[[], Any]  # base queryset for reads (annotated like the module's list)
    create: Callable[..., Any]  # (actor, validated_data, *, request) -> obj
    update: Callable[..., Any]  # (actor, obj, validated_data, *, expected_version, request) -> obj


@dataclass(frozen=True)
class ModuleDef:
    entity_type: str
    module: str  # permission prefix
    label: str
    label_plural: str
    fields: tuple[FieldDef, ...]
    binding: Callable[[], Binding]
    title_field: str = "name"
    # Columns a dedupe-on-import may match on, best first. Each entry is one or more field keys.
    dedupe_keys: tuple[tuple[str, ...], ...] = ()
    default_columns: tuple[str, ...] = ()
    # Holds CRM records that count towards the plan's record limit (DECISIONS M1.4 / M2.1).
    counts_as_record: bool = True
    _binding_cache: dict[str, Binding] = field(default_factory=dict, compare=False, repr=False)

    def bind(self) -> Binding:
        cached = self._binding_cache.get("b")
        if cached is None:
            cached = self._binding_cache["b"] = self.binding()
        return cached


_MODULES: dict[str, ModuleDef] = {}


def register(module: ModuleDef) -> None:
    keys = [f.key for f in module.fields]
    if len(keys) != len(set(keys)):
        raise ValueError(f"Duplicate field keys in module {module.entity_type}")
    _MODULES[module.entity_type] = module


def modules() -> list[ModuleDef]:
    return list(_MODULES.values())


def get(entity_type: str) -> ModuleDef:
    module = _MODULES.get(entity_type or "")
    if module is None:
        raise ValidationError({"entity_type": "Unknown module."})
    return module


def record_modules() -> tuple[str, ...]:
    """Entity types whose records count towards the plan's record limit."""
    return tuple(m.entity_type for m in _MODULES.values() if m.counts_as_record)


def custom_fields(entity_type: str) -> list[FieldDef]:
    from apps.customfields import service as customfields
    from apps.customfields.models import ENTITY_TYPES as CUSTOM_ENTITY_TYPES

    if entity_type not in CUSTOM_ENTITY_TYPES:
        return []
    out = []
    for d in customfields.active_definitions(entity_type):
        ftype = _CUSTOM_TYPES.get(d.field_type, TEXT)
        out.append(
            FieldDef(
                key=f"custom_data.{d.key}",
                label=d.label,
                type=ftype,
                required=d.is_required,
                choices=tuple(d.options or ()),
                groupable=ftype in {CHOICE, BOOLEAN},
                sort=None,
                custom=True,
            )
        )
    return out


def all_fields(entity_type: str) -> list[FieldDef]:
    return [*get(entity_type).fields, *custom_fields(entity_type)]


def fields_for(actor: Any, entity_type: str) -> list[FieldDef]:
    """The fields ``actor`` may see, with read-only ones flagged. Hidden fields are not in the list."""
    rules = actor.field_rules.get(entity_type, {}) if actor is not None else {}
    out: list[FieldDef] = []
    for f in all_fields(entity_type):
        access = rules.get(f.key)
        if access == "hidden":
            continue
        out.append(replace(f, read_only=True) if access == "read_only" else f)
    return out


def field_map(actor: Any, entity_type: str) -> dict[str, FieldDef]:
    return {f.key: f for f in fields_for(actor, entity_type)}


def describe(actor: Any, entity_type: str) -> dict[str, Any]:
    module = get(entity_type)
    return {
        "entity_type": module.entity_type,
        "label": module.label,
        "label_plural": module.label_plural,
        "title_field": module.title_field,
        "counts_as_record": module.counts_as_record,
        "default_columns": [c for c in module.default_columns if c in field_map(actor, entity_type)],
        "fields": [f.describe() for f in fields_for(actor, entity_type)],
    }


# ----------------------------------------------------------------------------- values


def _dig(obj: Any, path: str) -> Any:
    for part in path.split("."):
        if obj is None:
            return None
        obj = obj.get(part) if isinstance(obj, dict) else getattr(obj, part, None)
    return obj


def read_value(obj: Any, f: FieldDef, *, tags_map: dict | None = None) -> Any:
    """JSON-ready value of one field of one record."""
    if f.custom:
        return (obj.custom_data or {}).get(f.custom_key)
    if f.type == TAGS:
        tags = (tags_map or {}).get(obj.pk, [])
        return [{"id": str(t.pk), "name": t.name, "color_token": t.color_token} for t in tags]
    value = _dig(obj, f.source or f.key)
    if f.type in {LOOKUP, STAGE}:
        if value is None:
            return None
        name = getattr(value, "display_name", None) or getattr(value, "name", None) or str(value)
        ref: dict[str, Any] = {"id": str(value.pk), "name": name}
        if f.type == STAGE:
            ref["kind"] = getattr(value, "kind", None)
        return ref
    if f.type == USER:
        if value is None:
            return None
        return {"id": str(value.pk), "display_name": value.user.display_name}
    return to_json(value)


def to_json(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dt.datetime | dt.date):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def display_text(value: Any) -> str:
    """Plain text for exports and CSV cells."""
    if value is None:
        return ""
    if isinstance(value, dict):
        return str(value.get("name") or value.get("display_name") or "")
    if isinstance(value, list):
        return "; ".join(display_text(v) for v in value)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def write_payload(f: FieldDef, raw: Any) -> dict[str, Any]:
    """Map one cell value onto the module's write-serializer input."""
    if f.custom:
        return {"custom_data": {f.custom_key: raw if raw != "" else None}}
    if f.type in {LOOKUP, USER, STAGE}:
        if isinstance(raw, dict):
            raw = raw.get("id")
        key = f.write_key or f"{f.key}_id"
        return {key: raw or None}
    return {f.write_key or f.key: raw}


def sort_column(actor: Any, entity_type: str, key: str) -> str | None:
    f = field_map(actor, entity_type).get(key)
    return f.sort if f is not None else None


def validate_keys(actor: Any, entity_type: str, keys: Iterable[str], *, what: str = "columns") -> list[str]:
    """Keep the order, refuse unknown keys; hidden keys are refused like unknown ones (no oracle)."""
    known = field_map(actor, entity_type)
    out: list[str] = []
    for key in keys:
        if not isinstance(key, str) or key not in known:
            raise ValidationError({what: f"Unknown field '{str(key)[:60]}'."})
        if key not in out:
            out.append(key)
    return out
