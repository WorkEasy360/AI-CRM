"""The only path through which custom-field values are validated, filtered and written (ADR-0006).

Serializers hand raw ``custom_data`` to ``validate_values``; unknown keys, keys colliding with built-in
fields, wrong types, out-of-range values and oversized payloads are rejected. Filters go through
``apply_filters`` which only accepts keys that resolve to an active definition, so JSONB paths are
never constructed from raw client input.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from django.core.validators import EmailValidator
from django.db import transaction
from django.db.models import QuerySet
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.core import validators
from apps.core.exceptions import ConflictError, DomainError
from apps.customfields.models import ENTITY_TYPES, KEY_PATTERN, CustomFieldDefinition

FT = CustomFieldDefinition.FieldType

MAX_DEFINITIONS_PER_ENTITY = 100
MAX_OPTIONS = 100
MAX_OPTION_LENGTH = 80
MAX_TEXT = 255
MAX_TEXTAREA = 5000
MAX_PAYLOAD_BYTES = 64 * 1024
MAX_INTEGER = 2**53
_KEY_RE = re.compile(KEY_PATTERN)

# Built-in field names per entity that a custom key may never shadow (API field names + common aliases).
_COMMON_RESERVED = {
    "id",
    "organization",
    "organization_id",
    "owner",
    "owner_id",
    "version",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "archived_at",
    "custom_data",
    "tags",
    "notes",
    "type",
    "entity_type",
    "entity_id",
}
BUILTIN_KEYS: dict[str, frozenset[str]] = {
    "contact": frozenset(
        _COMMON_RESERVED
        | {
            "first_name",
            "last_name",
            "name",
            "email",
            "phone",
            "job_title",
            "company",
            "company_id",
            "source",
            "address",
        }
    ),
    "company": frozenset(
        _COMMON_RESERVED
        | {
            "name",
            "website",
            "phone",
            "industry",
            "company_size",
            "annual_revenue",
            "revenue_currency",
            "address",
            "source",
        }
    ),
    "deal": frozenset(
        _COMMON_RESERVED
        | {
            "name",
            "pipeline",
            "pipeline_id",
            "stage",
            "stage_id",
            "company",
            "company_id",
            "primary_contact",
            "primary_contact_id",
            "amount",
            "currency",
            "exchange_rate",
            "amount_base",
            "probability",
            "expected_close_date",
            "status",
            "closed_at",
            "lost_reason",
            "stage_entered_at",
            "products",
            "contacts",
        }
    ),
    "product": frozenset(
        _COMMON_RESERVED | {"name", "sku", "description", "unit_price", "currency", "tax_rate", "tax_label", "status"}
    ),
}

FILTERABLE_TYPES = frozenset(
    {
        FT.TEXT,
        FT.INTEGER,
        FT.NUMBER,
        FT.CURRENCY,
        FT.PERCENT,
        FT.DATE,
        FT.CHECKBOX,
        FT.DROPDOWN,
        FT.EMAIL,
        FT.PHONE,
        FT.URL,
    }
)
OPTION_TYPES = frozenset({FT.DROPDOWN, FT.MULTI_SELECT})


# ----------------------------------------------------------------------------- definitions


def active_definitions(entity_type: str) -> list[CustomFieldDefinition]:
    if entity_type not in ENTITY_TYPES:
        raise ValidationError({"entity_type": "Unknown entity type."})
    return list(
        CustomFieldDefinition.objects.filter(entity_type=entity_type, archived_at__isnull=True).order_by(
            "position", "created_at"
        )
    )


def _clean_options(field_type: str, options: Any) -> list[str]:
    if field_type not in OPTION_TYPES:
        if options:
            raise ValidationError({"options": "Options are only valid for dropdown and multi-select fields."})
        return []
    if not isinstance(options, list) or not options:
        raise ValidationError({"options": "Provide at least one option."})
    if len(options) > MAX_OPTIONS:
        raise ValidationError({"options": f"At most {MAX_OPTIONS} options."})
    cleaned: list[str] = []
    for opt in options:
        if not isinstance(opt, str):
            raise ValidationError({"options": "Options must be strings."})
        value = validators.clean_text(opt, max_length=MAX_OPTION_LENGTH)
        if not value:
            raise ValidationError({"options": "Options cannot be empty."})
        if value in cleaned:
            raise ValidationError({"options": f"Duplicate option '{value}'."})
        cleaned.append(value)
    return cleaned


def _validate_key(entity_type: str, key: str) -> str:
    key = (key or "").strip()
    if not _KEY_RE.match(key):
        raise ValidationError({"key": "Use 1-40 lowercase letters, digits or underscores, starting with a letter."})
    if key in BUILTIN_KEYS[entity_type]:
        raise ValidationError({"key": "This key is reserved by a built-in field."})
    return key


@transaction.atomic
def create_definition(
    actor: Actor,
    *,
    entity_type: str,
    key: str,
    label: str,
    field_type: str,
    options: Any = None,
    is_required: bool = False,
    description: str = "",
    request: Any = None,
) -> CustomFieldDefinition:
    check(actor, "customfields.manage")
    if entity_type not in ENTITY_TYPES:
        raise ValidationError({"entity_type": "Unknown entity type."})
    if field_type not in FT.values:
        raise ValidationError({"field_type": "Unknown field type."})
    key = _validate_key(entity_type, key)
    label = validators.clean_text(label, max_length=80)
    if not label:
        raise ValidationError({"label": "Label is required."})
    description = validators.clean_text(description, max_length=255)
    cleaned_options = _clean_options(field_type, options)
    existing = CustomFieldDefinition.objects.select_for_update().filter(entity_type=entity_type)
    if existing.filter(key=key).exists():
        raise ConflictError("A field with this key already exists (possibly archived).", code="customfield_key_taken")
    if existing.filter(archived_at__isnull=True).count() >= MAX_DEFINITIONS_PER_ENTITY:
        raise DomainError(f"At most {MAX_DEFINITIONS_PER_ENTITY} custom fields per entity.", code="customfield_limit")
    position = existing.count()
    definition = CustomFieldDefinition.objects.create(
        entity_type=entity_type,
        key=key,
        label=label,
        description=description,
        field_type=field_type,
        options=cleaned_options,
        is_required=bool(is_required),
        position=position,
    )
    audit.record(
        "customfields.created",
        request=request,
        user=actor.user,
        resource=definition,
        metadata={"entity_type": entity_type, "key": key, "field_type": field_type},
    )
    return definition


@transaction.atomic
def update_definition(actor: Actor, definition: CustomFieldDefinition, *, request: Any = None, **changes: Any):
    """``key``, ``entity_type`` and ``field_type`` are immutable (ADR-0006); archive and recreate instead."""
    check(actor, "customfields.manage", definition)
    changed: dict[str, Any] = {}
    if "label" in changes and changes["label"] is not None:
        label = validators.clean_text(changes["label"], max_length=80)
        if not label:
            raise ValidationError({"label": "Label is required."})
        definition.label = changed["label"] = label
    if "description" in changes and changes["description"] is not None:
        definition.description = changed["description"] = validators.clean_text(changes["description"], max_length=255)
    if "options" in changes and changes["options"] is not None:
        definition.options = changed["options"] = _clean_options(definition.field_type, changes["options"])
    if "is_required" in changes and changes["is_required"] is not None:
        definition.is_required = changed["is_required"] = bool(changes["is_required"])
    if "position" in changes and changes["position"] is not None:
        position = int(changes["position"])
        if position < 0 or position > 10_000:
            raise ValidationError({"position": "Out of range."})
        definition.position = changed["position"] = position
    if changed:
        definition.save(update_fields=[*changed.keys(), "updated_at"])
        audit.record("customfields.updated", request=request, user=actor.user, resource=definition, metadata=changed)
    return definition


@transaction.atomic
def archive_definition(actor: Actor, definition: CustomFieldDefinition, *, request: Any = None) -> None:
    check(actor, "customfields.manage", definition)
    if definition.archived_at is not None:
        return
    definition.archived_at = timezone.now()
    definition.save(update_fields=["archived_at", "updated_at"])
    audit.record("customfields.archived", request=request, user=actor.user, resource=definition)


# ----------------------------------------------------------------------------- values


def _coerce_decimal(value: Any, *, label: str) -> Decimal:
    if isinstance(value, bool):
        raise ValidationError(f"{label}: expected a number.")
    try:
        dec = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValidationError(f"{label}: expected a number.") from exc
    if not dec.is_finite():
        raise ValidationError(f"{label}: expected a finite number.")
    if abs(dec) > validators.MAX_AMOUNT:
        raise ValidationError(f"{label}: number is too large.")
    return dec


def coerce_value(definition: CustomFieldDefinition, value: Any) -> Any:
    """Coerce and validate one value against its definition. ``None``/``""`` mean "clear"."""
    ft = definition.field_type
    label = definition.label
    if value is None or (isinstance(value, str) and value.strip() == "") or (ft == FT.MULTI_SELECT and value == []):
        return None
    if ft == FT.TEXT:
        if not isinstance(value, str):
            raise ValidationError(f"{label}: expected text.")
        return validators.clean_text(value, max_length=MAX_TEXT)
    if ft == FT.TEXTAREA:
        if not isinstance(value, str):
            raise ValidationError(f"{label}: expected text.")
        return validators.clean_text(value, max_length=MAX_TEXTAREA, allow_newlines=True)
    if ft == FT.INTEGER:
        if isinstance(value, bool) or not isinstance(value, int | str):
            raise ValidationError(f"{label}: expected a whole number.")
        try:
            number = int(str(value).strip())
        except ValueError as exc:
            raise ValidationError(f"{label}: expected a whole number.") from exc
        if abs(number) > MAX_INTEGER:
            raise ValidationError(f"{label}: number is too large.")
        return number
    if ft in {FT.NUMBER, FT.CURRENCY, FT.PERCENT}:
        dec = _coerce_decimal(value, label=label)
        if ft == FT.PERCENT and not (Decimal(0) <= dec <= Decimal(100)):
            raise ValidationError(f"{label}: percent must be between 0 and 100.")
        if ft == FT.CURRENCY:
            dec = dec.quantize(Decimal("0.01"))
        return format(dec.normalize(), "f")
    if ft == FT.DATE:
        if not isinstance(value, str):
            raise ValidationError(f"{label}: expected a date (YYYY-MM-DD).")
        try:
            return dt.date.fromisoformat(value.strip()).isoformat()
        except ValueError as exc:
            raise ValidationError(f"{label}: expected a date (YYYY-MM-DD).") from exc
    if ft == FT.DATETIME:
        if not isinstance(value, str):
            raise ValidationError(f"{label}: expected an ISO 8601 date-time.")
        try:
            parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValidationError(f"{label}: expected an ISO 8601 date-time.") from exc
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.UTC)
        return parsed.astimezone(dt.UTC).isoformat()
    if ft == FT.CHECKBOX:
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in {"true", "false"}:
            return value.lower() == "true"
        raise ValidationError(f"{label}: expected true or false.")
    if ft == FT.DROPDOWN:
        if not isinstance(value, str) or value not in definition.options:
            raise ValidationError(f"{label}: choose one of the configured options.")
        return value
    if ft == FT.MULTI_SELECT:
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
            raise ValidationError(f"{label}: expected a list of options.")
        unique = list(dict.fromkeys(value))
        if any(v not in definition.options for v in unique):
            raise ValidationError(f"{label}: choose only configured options.")
        return unique
    if ft == FT.EMAIL:
        if not isinstance(value, str):
            raise ValidationError(f"{label}: expected an email address.")
        value = validators.clean_text(value, max_length=254).lower()
        try:
            EmailValidator()(value)
        except Exception as exc:
            raise ValidationError(f"{label}: enter a valid email address.") from exc
        return value
    if ft == FT.PHONE:
        if not isinstance(value, str):
            raise ValidationError(f"{label}: expected a phone number.")
        try:
            return validators.clean_phone(value)
        except ValidationError as exc:
            raise ValidationError(f"{label}: enter a valid phone number.") from exc
    if ft == FT.URL:
        if not isinstance(value, str):
            raise ValidationError(f"{label}: expected a URL.")
        try:
            return validators.clean_url(value)
        except ValidationError as exc:
            raise ValidationError(f"{label}: enter a valid http(s) URL.") from exc
    raise ValidationError(f"{label}: unsupported field type.")  # pragma: no cover


def validate_values(
    entity_type: str, data: Any, *, partial: bool = False, existing: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Validate a ``custom_data`` payload. Returns the full cleaned dict to store.

    - unknown keys → error (no silent drops: a typo must not lose data quietly)
    - ``partial`` merges over ``existing`` (PATCH); a key set to null clears it
    - required fields are enforced on the merged result
    """
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValidationError({"custom_data": "Expected an object."})
    if len(json.dumps(data, default=str)) > MAX_PAYLOAD_BYTES:
        raise ValidationError({"custom_data": "Custom data payload is too large."})
    definitions = {d.key: d for d in active_definitions(entity_type)}
    errors: dict[str, str] = {}
    result: dict[str, Any] = {}
    if partial and existing:
        result = {k: v for k, v in existing.items() if k in definitions}
    for raw_key, raw_value in data.items():
        key = str(raw_key)
        definition = definitions.get(key)
        if definition is None:
            errors[key] = "Unknown custom field."
            continue
        try:
            cleaned = coerce_value(definition, raw_value)
        except ValidationError as exc:
            errors[key] = _message(exc)
            continue
        if cleaned is None:
            result.pop(key, None)
        else:
            result[key] = cleaned
    for key, definition in definitions.items():
        if definition.is_required and key not in result and key not in errors:
            errors[key] = f"{definition.label} is required."
    if errors:
        raise ValidationError({f"custom_data.{k}": v for k, v in errors.items()})
    return result


def _message(exc: ValidationError) -> str:
    detail = exc.detail
    if isinstance(detail, list) and detail:
        return str(detail[0])
    if isinstance(detail, dict) and detail:
        return str(next(iter(detail.values())))
    return str(detail)


def public_values(entity_type: str, custom_data: dict[str, Any] | None, definitions=None) -> dict[str, Any]:
    """Only keys with an active definition are exposed (archived fields disappear from the API)."""
    if not custom_data:
        return {}
    keys = {d.key for d in (definitions if definitions is not None else active_definitions(entity_type))}
    return {k: v for k, v in custom_data.items() if k in keys}


def apply_filters(qs: QuerySet, entity_type: str, raw_filters: dict[str, str]) -> QuerySet:
    """``?custom.<key>=<value>`` equality filters. Keys must be active, filterable definitions."""
    definitions = {d.key: d for d in active_definitions(entity_type)}
    errors: dict[str, str] = {}
    for key, raw in raw_filters.items():
        definition = definitions.get(key)
        if definition is None or not _KEY_RE.match(key):
            errors[key] = "Unknown custom field."
            continue
        if definition.field_type not in FILTERABLE_TYPES:
            errors[key] = "This field type cannot be filtered."
            continue
        try:
            value = coerce_value(definition, raw)
        except ValidationError as exc:
            errors[key] = _message(exc)
            continue
        if value is None:
            qs = qs.filter(**{f"custom_data__{key}__isnull": True})
        else:
            qs = qs.filter(**{f"custom_data__{key}": value})
    if errors:
        raise ValidationError(errors)
    return qs
