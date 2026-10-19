"""The reporting hierarchy: who reports to whom, and what "role and subordinates" reaches.

The tree is small (tens of roles), so it is loaded whole and walked in Python instead of a recursive
query. Cycles are refused when a parent is set, but the walk still tracks visited nodes so a corrupt
row can never loop.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any

from django.db import transaction
from rest_framework.exceptions import PermissionDenied

from apps.audit import service as audit
from apps.core import validators
from apps.core.exceptions import ConflictError, DomainError

MAX_HIERARCHY_ROLES = 200


def _children_map() -> dict[uuid.UUID | None, list[uuid.UUID]]:
    from apps.authz.models import HierarchyRole

    children: dict[uuid.UUID | None, list[uuid.UUID]] = defaultdict(list)
    for role_id, parent_id in HierarchyRole.objects.values_list("id", "parent_id"):
        children[parent_id].append(role_id)
    return children


def descendants(role_id: uuid.UUID, children: dict[uuid.UUID | None, list[uuid.UUID]] | None = None) -> set[uuid.UUID]:
    """Every role strictly below ``role_id``."""
    children = children if children is not None else _children_map()
    found: set[uuid.UUID] = set()
    stack = list(children.get(role_id, ()))
    while stack:
        node = stack.pop()
        if node in found or node == role_id:
            continue
        found.add(node)
        stack.extend(children.get(node, ()))
    return found


def subordinate_member_ids(membership) -> frozenset[uuid.UUID]:
    from apps.accounts.models import Membership
    from apps.authz.models import HierarchyRole

    role_id = membership.hierarchy_role_id
    if role_id is None:
        return frozenset({membership.id})
    roles = descendants(role_id)
    if HierarchyRole.objects.filter(pk=role_id, share_with_peers=True).exists():
        roles.add(role_id)
    if not roles:
        return frozenset({membership.id})
    ids = Membership.objects.filter(hierarchy_role_id__in=roles).values_list("id", flat=True)
    return frozenset(ids) | {membership.id}


# ----------------------------------------------------------------------------- management


def _clean_name(name: str) -> str:
    name = validators.clean_text(name or "", max_length=80)
    if not name:
        raise DomainError("Name is required.", code="invalid_name")
    return name


def _assert_parent(role, parent) -> None:
    if parent is None:
        return
    if role is not None and (parent.pk == role.pk or parent.pk in descendants(role.pk)):
        raise DomainError("A role cannot report to itself or to one of its subordinates.", code="hierarchy_cycle")


@transaction.atomic
def create_role(actor, *, name: str, parent=None, description: str = "", share_with_peers: bool = False, request=None):
    from apps.authz.models import HierarchyRole
    from apps.authz.service import check

    check(actor, "roles.manage")
    name = _clean_name(name)
    if HierarchyRole.objects.filter(name__iexact=name).exists():
        raise ConflictError("A role with this name already exists.", code="hierarchy_role_name_taken")
    if HierarchyRole.objects.count() >= MAX_HIERARCHY_ROLES:
        raise DomainError(f"At most {MAX_HIERARCHY_ROLES} roles.", code="hierarchy_role_limit")
    role = HierarchyRole.objects.create(
        name=name,
        parent=parent,
        description=validators.clean_text(description or "", max_length=255),
        share_with_peers=bool(share_with_peers),
    )
    audit.record(
        "hierarchy.role_created",
        request=request,
        user=actor.user,
        resource=role,
        metadata={"after": {"name": name, "parent_id": str(parent.pk) if parent else None}},
    )
    return role


@transaction.atomic
def update_role(actor, role, *, request=None, **changes: Any):
    from apps.authz.models import HierarchyRole
    from apps.authz.service import check

    check(actor, "roles.manage")
    before = {"name": role.name, "parent_id": str(role.parent_id) if role.parent_id else None}
    if "name" in changes:
        name = _clean_name(changes["name"])
        if HierarchyRole.objects.filter(name__iexact=name).exclude(pk=role.pk).exists():
            raise ConflictError("A role with this name already exists.", code="hierarchy_role_name_taken")
        role.name = name
    if "parent" in changes:
        _assert_parent(role, changes["parent"])
        role.parent = changes["parent"]
    if "description" in changes:
        role.description = validators.clean_text(changes["description"] or "", max_length=255)
    if "share_with_peers" in changes:
        role.share_with_peers = bool(changes["share_with_peers"])
    role.save()
    after = {"name": role.name, "parent_id": str(role.parent_id) if role.parent_id else None}
    audit.record(
        "hierarchy.role_updated",
        request=request,
        user=actor.user,
        resource=role,
        metadata={"before": before, "after": after},
    )
    return role


@transaction.atomic
def delete_role(actor, role, *, request=None) -> None:
    """Delete a role; its sub-roles and members move up to its parent so nobody drops out of the tree."""
    from apps.accounts.models import Membership
    from apps.authz.models import HierarchyRole
    from apps.authz.service import check

    check(actor, "roles.manage")
    parent_id = role.parent_id
    HierarchyRole.objects.filter(parent_id=role.pk).update(parent_id=parent_id)
    moved = Membership.objects.filter(hierarchy_role_id=role.pk).update(hierarchy_role_id=parent_id)
    role_id, name = role.pk, role.name
    role.delete()
    audit.record(
        "hierarchy.role_deleted",
        request=request,
        user=actor.user,
        resource_type="hierarchyrole",
        resource_id=role_id,
        metadata={"before": {"name": name}, "members_moved": moved},
    )


@transaction.atomic
def assign_member(actor, membership, role, *, request=None):
    from apps.authz.roles import OWNER
    from apps.authz.service import check

    check(actor, "roles.manage")
    if membership.pk == actor.membership.pk and actor.role_key != OWNER:
        # Moving yourself up the tree would widen what your own "subordinates" scope reaches.
        raise PermissionDenied(detail="Ask an owner to change your own place in the hierarchy.", code="self_placement")
    before = str(membership.hierarchy_role_id) if membership.hierarchy_role_id else None
    membership.hierarchy_role = role
    membership.save(update_fields=["hierarchy_role", "updated_at"])
    audit.record(
        "members.hierarchy_role_changed",
        request=request,
        user=actor.user,
        resource=membership,
        metadata={"before": before, "after": str(role.pk) if role else None},
    )
    return membership
