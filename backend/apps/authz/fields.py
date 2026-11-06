"""Field-level permissions: fields a permission set may not see (hidden) or may not change (read-only).

Rules are rows of ``FieldPermission`` keyed by the API field name (``email``) or ``custom_data.<key>``.
No row means read/write. The Owner permission set can never be restricted, so an organization cannot
lock itself out of its own data.

Enforced in two places that every record read and write passes through:
- ``mask`` on the read serializers (lists, detail, the Kanban card) and exports;
- ``assert_writable`` in ``apps.crm.records`` before create/update.
"""

from __future__ import annotations

import contextlib
import re
from collections.abc import Iterable, Mapping
from typing import Any

from django.core.cache import cache
from django.db import transaction
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import service as audit

HIDDEN = "hidden"
READ_ONLY = "read_only"
# "deal_line" is a deal's product lines (quantity, unit_price, discount_percent, tax_rate).
ENTITY_TYPES = ("contact", "company", "deal", "product", "deal_line")
# Identity and bookkeeping fields every client depends on; never restrictable.
PROTECTED_FIELDS = frozenset(
    {"id", "version", "created_at", "updated_at", "archived_at", "tags", "custom_data", "owner", "name"}
)
FIELD_PATTERN = re.compile(r"^(custom_data\.)?[a-z][a-z0-9_]{0,63}$")
# Values computed from a restricted field leak it too, so they share its rule.
DERIVED_FIELDS: Mapping[str, Mapping[str, tuple[str, ...]]] = {
    "deal": {"amount": ("amount_base", "weighted_amount_base", "products_total")},
    "deal_line": {"unit_price": ("subtotal", "tax_amount", "line_total")},
    "company": {"annual_revenue": ("annual_revenue_base",)},
}


# Written by the services themselves (a deal's status follows its stage), never by the caller.
SYSTEM_MAINTAINED: Mapping[str, frozenset[str]] = {
    "deal": frozenset(
        {"status", "stage_entered_at", "closed_at", "probability_overridden", "last_activity_at", "amount_base"}
    ),
    "contact": frozenset({"whatsapp_opt_in_at"}),
}


RULES_TTL = 300


def _cache_key(organization_id, role_id) -> str:
    return f"authz:fieldrules:{organization_id}:{role_id}"


def rules_for_role(role, organization_id) -> dict[str, dict[str, str]]:
    """Rules of ``role`` in ``organization_id``: explicit, because system roles are shared by every tenant."""
    from apps.authz.roles import OWNER

    if role is None or (role.is_system and role.key == OWNER):
        return {}
    key = _cache_key(organization_id, role.pk)
    try:
        cached = cache.get(key)
    except Exception:  # cache down: read the rows
        cached = None
    if cached is not None:
        return cached
    rules = _load_rules(role, organization_id)
    with contextlib.suppress(Exception):  # best effort: a cold cache only costs a query
        cache.set(key, rules, RULES_TTL)
    return rules


def _invalidate(organization_id, role_id) -> None:
    with contextlib.suppress(Exception):  # the TTL takes over
        cache.delete(_cache_key(organization_id, role_id))


def _load_rules(role, organization_id) -> dict[str, dict[str, str]]:
    from apps.authz.models import FieldPermission

    rules: dict[str, dict[str, str]] = {}
    rows = FieldPermission.objects.filter(organization_id=organization_id, role_id=role.pk)
    for entity_type, field, access in rows.values_list("entity_type", "field", "access"):
        bucket = rules.setdefault(entity_type, {})
        bucket[field] = access
        for derived in DERIVED_FIELDS.get(entity_type, {}).get(field, ()):
            bucket.setdefault(derived, access)
    return rules


def hidden_fields(actor, entity_type: str) -> frozenset[str]:
    if actor is None:
        return frozenset()
    rules = actor.field_rules.get(entity_type, {})
    return frozenset(f for f, access in rules.items() if access == HIDDEN)


def mask(actor, entity_type: str, data: dict[str, Any]) -> dict[str, Any]:
    """Drop hidden fields (and hidden custom fields) from one serialized record, in place."""
    hidden = hidden_fields(actor, entity_type)
    if not hidden:
        return data
    for field in hidden:
        if field.startswith("custom_data."):
            custom = data.get("custom_data")
            if isinstance(custom, dict):
                custom.pop(field.removeprefix("custom_data."), None)
        else:
            data.pop(field, None)
    return data


def assert_writable(
    actor, entity_type: str, data: Mapping[str, Any], *, existing_custom: Mapping | None = None
) -> None:
    """Refuse a write that touches a field the actor may only read (or not see at all)."""
    rules = actor.field_rules.get(entity_type, {}) if actor is not None else {}
    if not rules:
        return
    touched = {k for k in data if k != "custom_data" and k not in SYSTEM_MAINTAINED.get(entity_type, ())}
    custom = data.get("custom_data")
    if isinstance(custom, Mapping):
        existing_custom = existing_custom or {}
        touched |= {f"custom_data.{k}" for k, v in custom.items() if existing_custom.get(k) != v}
    blocked = sorted(f for f in touched if f in rules)
    if blocked:
        raise PermissionDenied(
            detail=f"You cannot change: {', '.join(blocked)}.",
            code="field_read_only",
        )


# ----------------------------------------------------------------------------- management


def _validate_rules(entity_type: str, rules: Iterable[Mapping[str, Any]]) -> list[tuple[str, str]]:
    if entity_type not in ENTITY_TYPES:
        raise ValidationError({"entity_type": "Unknown entity type."})
    cleaned: dict[str, str] = {}
    for rule in rules:
        field = str(rule.get("field", ""))
        access = rule.get("access")
        if not FIELD_PATTERN.match(field) or field in PROTECTED_FIELDS:
            raise ValidationError({"rules": f"Field '{field}' cannot be restricted."})
        if access not in (HIDDEN, READ_ONLY):
            raise ValidationError({"rules": "access must be 'hidden' or 'read_only'."})
        cleaned[field] = access
    if len(cleaned) > 200:
        raise ValidationError({"rules": "At most 200 rules per module."})
    return sorted(cleaned.items())


@transaction.atomic
def set_rules(
    actor, role, *, entity_type: str, rules: Iterable[Mapping[str, Any]], request=None
) -> list[tuple[str, str]]:
    """Replace the rules of ``role`` for one module."""
    from apps.authz.models import FieldPermission
    from apps.authz.roles import OWNER
    from apps.authz.service import check

    check(actor, "roles.manage")
    if role.is_system and role.key == OWNER:
        raise ValidationError({"role": "The Owner permission set cannot be restricted."})
    cleaned = _validate_rules(entity_type, rules)
    existing = FieldPermission.objects.filter(role_id=role.pk, entity_type=entity_type)
    before = sorted(existing.values_list("field", "access"))
    existing.delete()
    FieldPermission.objects.bulk_create(
        # bulk_create skips TenantModel.save(), so the organization is set explicitly.
        [
            FieldPermission(
                organization_id=actor.organization.pk, role=role, entity_type=entity_type, field=f, access=a
            )
            for f, a in cleaned
        ]
    )
    org_id = actor.organization.pk
    transaction.on_commit(lambda: _invalidate(org_id, role.pk))
    _invalidate(org_id, role.pk)
    audit.record(
        "roles.field_permissions_changed",
        request=request,
        user=actor.user,
        resource_type="role",
        resource_id=role.pk,
        metadata={"role": role.key, "entity_type": entity_type, "before": before, "after": cleaned},
    )
    return cleaned
