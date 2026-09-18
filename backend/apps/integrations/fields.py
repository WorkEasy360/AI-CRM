"""What CRM data an integration may ever see or write: the server-side allowlist and the hard denylist.

Three layers, all enforced here and never configurable from a client:

1. ``ENTITIES``: only these record types can be shared, and only the listed standard fields exist
   for integrations. Notes, email bodies, WhatsApp conversations, attachments and AI conversations
   are declared non-shareable.
2. ``DENIED_FIELD_FRAGMENTS``: any field name (standard or custom) containing one of these fragments
   is refused even if someone adds it to the allowlist or names a custom field that way.
3. The connection's own ``FieldMapping`` rows: only mapped fields travel (least data).
"""

from __future__ import annotations

import datetime as dt
import decimal
import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any

from rest_framework.exceptions import ValidationError

CUSTOM_PREFIX = "custom."

# Substrings that mark security-internal data. Checked case-insensitively against CRM field names.
DENIED_FIELD_FRAGMENTS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "session",
    "csrf",
    "mfa",
    "totp",
    "otp_",
    "recovery",
    "authenticator",
    "api_key",
    "apikey",
    "private_key",
    "encrypt",
    "credential",
    "hash",
    "salt",
    "_enc",
    "signature",
    "search_vector",
)


@dataclass(frozen=True)
class EntitySpec:
    key: str
    label: str
    shareable: bool
    readable: tuple[str, ...] = ()  # may leave the CRM (outbound, webhook payloads)
    writable: tuple[str, ...] = ()  # may be written from outside (inbound)
    inbound_create: bool = False  # inbound sync may create new records (else update-only)
    permission_module: str = ""
    custom_fields: bool = False
    reason: str = ""


ENTITIES: dict[str, EntitySpec] = {
    "contact": EntitySpec(
        key="contact",
        label="Contacts",
        shareable=True,
        readable=(
            "first_name",
            "last_name",
            "email",
            "phone",
            "job_title",
            "company_id",
            "company_name",
            "source",
            "lifecycle_stage",
            "address",
            "created_at",
            "updated_at",
        ),
        writable=("first_name", "last_name", "email", "phone", "job_title", "source", "address"),
        inbound_create=True,
        permission_module="contacts",
        custom_fields=True,
    ),
    "company": EntitySpec(
        key="company",
        label="Companies",
        shareable=True,
        readable=(
            "name",
            "website",
            "phone",
            "industry",
            "company_size",
            "annual_revenue",
            "revenue_currency",
            "source",
            "lifecycle_stage",
            "address",
            "created_at",
            "updated_at",
        ),
        writable=(
            "name",
            "website",
            "phone",
            "industry",
            "company_size",
            "annual_revenue",
            "revenue_currency",
            "source",
        ),
        inbound_create=True,
        permission_module="companies",
        custom_fields=True,
    ),
    "deal": EntitySpec(
        key="deal",
        label="Deals",
        shareable=True,
        readable=(
            "name",
            "amount",
            "currency",
            "probability",
            "expected_close_date",
            "status",
            "stage_name",
            "pipeline_name",
            "company_id",
            "primary_contact_id",
            "closed_at",
            "created_at",
            "updated_at",
        ),
        # Stage and pipeline changes keep their history through the stage endpoint only.
        writable=("name", "amount", "expected_close_date"),
        inbound_create=False,
        permission_module="deals",
        custom_fields=True,
    ),
    "note": EntitySpec(key="note", label="Notes", shareable=False, reason="Internal notes are never shared."),
    "email": EntitySpec(key="email", label="Email", shareable=False, reason="Email content is never shared."),
    "whatsapp": EntitySpec(
        key="whatsapp", label="WhatsApp", shareable=False, reason="WhatsApp conversations are never shared."
    ),
    "attachment": EntitySpec(
        key="attachment", label="Attachments", shareable=False, reason="Private files are never shared."
    ),
}

SHAREABLE_ENTITIES: tuple[str, ...] = tuple(k for k, v in ENTITIES.items() if v.shareable)
_EXTERNAL_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-]{0,127}$")


def is_denied(field_name: str) -> bool:
    lowered = field_name.lower()
    return any(fragment in lowered for fragment in DENIED_FIELD_FRAGMENTS)


def entity(entity_type: str, *, shareable: bool = True) -> EntitySpec:
    spec = ENTITIES.get(entity_type)
    if spec is None or (shareable and not spec.shareable):
        raise ValidationError({"entity_type": "This data type cannot be shared with integrations."})
    return spec


def custom_field_keys(entity_type: str) -> list[str]:
    """Active custom fields of the current organization that may be mapped (denylist applied)."""
    spec = ENTITIES[entity_type]
    if not spec.custom_fields:
        return []
    from apps.customfields.service import active_definitions

    return [d.key for d in active_definitions(entity_type) if not is_denied(d.key)]


def allowed_fields(entity_type: str, *, direction: str) -> list[str]:
    """``direction`` is "outbound" (read from CRM) or "inbound" (written into CRM)."""
    spec = entity(entity_type)
    base = spec.readable if direction == "outbound" else spec.writable
    fields = [f for f in base if not is_denied(f)]
    fields += [f"{CUSTOM_PREFIX}{key}" for key in custom_field_keys(entity_type)]
    return fields


def validate_mappings(entity_type: str, direction: str, mappings: list[dict[str, str]]) -> list[dict[str, str]]:
    """Normalise and validate a full mapping set for one entity before it is saved or used.

    Every CRM field must be allowed in each direction the policy uses; external names must be plain
    identifiers; no field may appear twice on either side.
    """
    entity(entity_type)
    if direction == "none":
        return []
    directions = ["outbound", "inbound"] if direction == "two_way" else [direction]
    allowed = set.intersection(*(set(allowed_fields(entity_type, direction=d)) for d in directions))
    seen_crm: set[str] = set()
    seen_ext: set[str] = set()
    cleaned: list[dict[str, str]] = []
    errors: list[str] = []
    for item in mappings:
        crm_field = str(item.get("crm_field", "")).strip()
        external_field = str(item.get("external_field", "")).strip()
        if is_denied(crm_field):
            errors.append(f"{crm_field}: security-sensitive data can never be shared.")
            continue
        if crm_field not in allowed:
            errors.append(f"{crm_field or '(empty)'}: not available for {direction.replace('_', '-')} sharing.")
            continue
        if not _EXTERNAL_FIELD_RE.match(external_field):
            errors.append(f"{crm_field}: enter a valid external field name.")
            continue
        if crm_field in seen_crm or external_field in seen_ext:
            errors.append(f"{crm_field} → {external_field}: each field can be mapped once.")
            continue
        seen_crm.add(crm_field)
        seen_ext.add(external_field)
        cleaned.append({"crm_field": crm_field, "external_field": external_field})
    if errors:
        raise ValidationError({"mappings": errors[:20]})
    if not cleaned:
        raise ValidationError({"mappings": ["Map at least one field before sharing this data."]})
    return cleaned


def _json_value(value: Any) -> Any:
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, dt.datetime | dt.date):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dict | list | str | int | float | bool) or value is None:
        return value
    return str(value)


def read_field(record: Any, field_name: str) -> Any:
    """Value of one allowlisted field of a CRM record (JSON-safe)."""
    if is_denied(field_name):
        raise ValueError(f"Denied field: {field_name}")
    if field_name.startswith(CUSTOM_PREFIX):
        return _json_value((record.custom_data or {}).get(field_name[len(CUSTOM_PREFIX) :]))
    if field_name == "company_name":
        company = getattr(record, "company", None)
        return company.name if company is not None else None
    if field_name == "stage_name":
        return record.stage.name if getattr(record, "stage_id", None) else None
    if field_name == "pipeline_name":
        return record.pipeline.name if getattr(record, "pipeline_id", None) else None
    return _json_value(getattr(record, field_name))


def outbound_values(entity_type: str, record: Any, mappings: list[dict[str, str]]) -> dict[str, Any]:
    """External payload for one record: mapped fields only, re-checked against the live allowlist."""
    allowed = set(allowed_fields(entity_type, direction="outbound"))
    return {m["external_field"]: read_field(record, m["crm_field"]) for m in mappings if m["crm_field"] in allowed}


def inbound_values(entity_type: str, external: dict[str, Any], mappings: list[dict[str, str]]) -> dict[str, Any]:
    """CRM field values from an external record: mapped, writable fields only; everything else is dropped."""
    allowed = set(allowed_fields(entity_type, direction="inbound"))
    values: dict[str, Any] = {}
    for m in mappings:
        if m["crm_field"] in allowed and m["external_field"] in external:
            values[m["crm_field"]] = external[m["external_field"]]
    return values


# Records that are announced by webhooks but never synchronized.
WEBHOOK_ONLY_FIELDS: dict[str, tuple[str, ...]] = {
    "activity": (
        "kind",
        "title",
        "status",
        "priority",
        "start_at",
        "completed_at",
        "contact_id",
        "company_id",
        "deal_id",
        "created_at",
        "updated_at",
    ),
}
WEBHOOK_ENTITY_PERMISSIONS: dict[str, str] = {
    "contact": "contacts.view",
    "company": "companies.view",
    "deal": "deals.view",
    "activity": "activities.view",
}


def snapshot(entity_type: str, record: Any) -> dict[str, Any]:
    """Standard allowlisted fields for webhook payloads (no custom fields: those are opt-in via mappings)."""
    names = WEBHOOK_ONLY_FIELDS.get(entity_type) or entity(entity_type).readable
    return {name: read_field(record, name) for name in names if not is_denied(name)}


def stable_hash(values: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(values, sort_keys=True, default=str).encode("utf-8")).hexdigest()
