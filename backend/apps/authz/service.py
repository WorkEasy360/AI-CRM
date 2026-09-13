"""The only place authorization decisions are made.

``check()`` raises; ``scope()`` narrows querysets. Views, services, background jobs and AI tools all
call these two functions. Deny by default: an unknown or ungranted permission never passes.
"""

from __future__ import annotations

from typing import Any

from django.db.models import QuerySet
from rest_framework.exceptions import PermissionDenied

from apps.authz.actor import Actor
from apps.authz.catalogue import SCOPE_ALL, SCOPE_OWN, SCOPE_TEAM, validate_permission


def _owner_field(model: type) -> str | None:
    return getattr(model, "OWNER_FIELD", None)


def check(actor: Actor | None, permission: str, obj: Any | None = None) -> None:
    validate_permission(permission)
    if actor is None:
        raise PermissionDenied(detail="No active organization.", code="no_active_organization")
    scope = actor.scope_for(permission)
    if scope is None:
        raise PermissionDenied(code="permission_denied")
    if obj is None or scope == SCOPE_ALL:
        return
    owner_field = _owner_field(type(obj))
    owner_id = getattr(obj, f"{owner_field}_id", None) if owner_field else None
    if not actor.covers_owner(permission, owner_id):
        raise PermissionDenied(code="permission_denied")


def scope(actor: Actor | None, permission: str, queryset: QuerySet) -> QuerySet:
    validate_permission(permission)
    if actor is None:
        return queryset.none()
    granted = actor.scope_for(permission)
    if granted is None:
        return queryset.none()
    if granted == SCOPE_ALL:
        return queryset
    owner_field = _owner_field(queryset.model)
    if owner_field is None:
        # Models without ownership are only reachable with the 'all' scope.
        return queryset.none()
    if granted == SCOPE_OWN:
        return queryset.filter(**{f"{owner_field}_id": actor.membership.id})
    if granted == SCOPE_TEAM:
        return queryset.filter(**{f"{owner_field}_id__in": actor.team_member_ids})
    return queryset.none()


def has(actor: Actor | None, permission: str) -> bool:
    validate_permission(permission)
    return actor is not None and actor.has(permission)
