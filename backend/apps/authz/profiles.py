"""Custom permission sets ("profiles"): an organization's own roles next to the five system ones.

Guard rails:
- a custom set can never hold an owner-only permission (deleting the organization, billing, erasure);
- nobody can create, edit or assign a set that grants more than they hold themselves (no escalation);
- a set still assigned to someone cannot be deleted.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from django.db import transaction
from django.utils.text import slugify
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import service as audit
from apps.authz.catalogue import PERMISSIONS, SCOPES, scope_covers
from apps.authz.roles import SYSTEM_ROLES
from apps.core import validators
from apps.core.exceptions import ConflictError, DomainError

OWNER_ONLY = frozenset({"org.delete", "org.billing", "privacy.delete_data"})
MAX_CUSTOM_ROLES = 50


def clean_grants(grants: Any) -> dict[str, str]:
    if not isinstance(grants, Mapping):
        raise ValidationError({"grants": "Expected an object of permission: scope."})
    cleaned: dict[str, str] = {}
    for permission, scope in grants.items():
        if permission not in PERMISSIONS:
            raise ValidationError({"grants": f"Unknown permission '{permission}'."})
        if permission in OWNER_ONLY:
            raise ValidationError({"grants": f"'{permission}' is reserved for the Owner."})
        if scope not in SCOPES:
            raise ValidationError({"grants": f"Unknown scope '{scope}'."})
        cleaned[permission] = scope
    return cleaned


def assert_within_actor(actor, grants: Mapping[str, str]) -> None:
    beyond = sorted(p for p, s in grants.items() if not scope_covers(actor.scope_for(p), s))
    if beyond:
        raise PermissionDenied(
            detail=f"You cannot grant permissions you do not hold: {', '.join(beyond[:5])}.",
            code="grant_escalation",
        )


def _unique_key(name: str) -> str:
    from apps.authz.models import Role

    base = (slugify(name)[:32] or "role").replace("-", "_")
    key, n = base, 2
    while key in SYSTEM_ROLES or Role.objects.filter(key=key).exists():
        key = f"{base[:30]}_{n}"
        n += 1
    return key


def _grants_of(role) -> dict[str, str]:
    if role.is_system:
        return dict(SYSTEM_ROLES[role.key].grants)
    return {g.permission: g.scope for g in role.grants.all()}


@transaction.atomic
def create_profile(actor, *, name: str, description: str = "", grants: Any = None, clone_from: str = "", request=None):
    from apps.authz.models import Role, RolePermission
    from apps.authz.service import check

    check(actor, "roles.manage")
    name = validators.clean_text(name or "", max_length=80)
    if not name:
        raise ValidationError({"name": "Name is required."})
    if Role.objects.filter(organization__isnull=False, name__iexact=name).exists() or any(
        d.name.lower() == name.lower() for d in SYSTEM_ROLES.values()
    ):
        raise ConflictError("A role with this name already exists.", code="role_name_taken")
    if Role.objects.filter(organization__isnull=False).count() >= MAX_CUSTOM_ROLES:
        raise DomainError(f"At most {MAX_CUSTOM_ROLES} custom roles.", code="role_limit")
    if grants is None and clone_from:
        source = Role.objects.filter(key=clone_from).first()
        if source is None:
            raise ValidationError({"clone_from": "Unknown role."})
        grants = {p: s for p, s in _grants_of(source).items() if p not in OWNER_ONLY}
    cleaned = clean_grants(grants or {})
    assert_within_actor(actor, cleaned)
    role = Role.objects.create(
        organization=actor.organization,
        key=_unique_key(name),
        name=name,
        description=validators.clean_text(description or "", max_length=255),
        is_system=False,
    )
    RolePermission.objects.bulk_create([RolePermission(role=role, permission=p, scope=s) for p, s in cleaned.items()])
    audit.record(
        "roles.created", request=request, user=actor.user, resource=role, metadata={"key": role.key, "after": cleaned}
    )
    return role


@transaction.atomic
def update_profile(actor, role, *, request=None, **changes: Any):
    from apps.authz.models import Role, RolePermission
    from apps.authz.service import check

    check(actor, "roles.manage")
    if role.is_system:
        raise PermissionDenied(detail="System roles cannot be changed.", code="system_role")
    before = _grants_of(role)
    if "name" in changes:
        name = validators.clean_text(changes["name"] or "", max_length=80)
        if not name:
            raise ValidationError({"name": "Name is required."})
        if Role.objects.filter(organization__isnull=False, name__iexact=name).exclude(pk=role.pk).exists():
            raise ConflictError("A role with this name already exists.", code="role_name_taken")
        role.name = name
    if "description" in changes:
        role.description = validators.clean_text(changes["description"] or "", max_length=255)
    role.save()
    after = before
    if "grants" in changes:
        after = clean_grants(changes["grants"])
        # Both directions: an actor may not add what they lack, nor quietly strip a set above them.
        assert_within_actor(actor, after)
        assert_within_actor(actor, before)
        RolePermission.objects.filter(role=role).delete()
        RolePermission.objects.bulk_create([RolePermission(role=role, permission=p, scope=s) for p, s in after.items()])
    audit.record(
        "roles.updated",
        request=request,
        user=actor.user,
        resource=role,
        metadata={"key": role.key, "before": before, "after": after},
    )
    return role


@transaction.atomic
def delete_profile(actor, role, *, request=None) -> None:
    from apps.accounts.models import Invitation, Membership
    from apps.authz.service import check

    check(actor, "roles.manage")
    if role.is_system:
        raise PermissionDenied(detail="System roles cannot be deleted.", code="system_role")
    if Membership.objects.filter(role=role).exists() or Invitation.objects.filter(role=role).exists():
        raise ConflictError("Move everyone off this role before deleting it.", code="role_in_use")
    key, grants = role.key, _grants_of(role)
    role_id = role.pk
    role.delete()
    audit.record(
        "roles.deleted",
        request=request,
        user=actor.user,
        resource_type="role",
        resource_id=role_id,
        metadata={"key": key, "before": grants},
    )


def assignable_custom_role(actor, role_key: str):
    """The custom role ``role_key`` if ``actor`` may assign it, else raise."""
    from apps.authz.models import Role

    role = Role.objects.filter(key=role_key, organization_id=actor.organization.pk, is_system=False).first()
    if role is None:
        raise DomainError("Unknown role.", code="invalid_role")
    assert_within_actor(actor, _grants_of(role))
    return role
