"""The only place authorization decisions are made.

``check()`` raises; ``scope()`` narrows querysets. Views, services, background jobs and AI tools all
call these two functions. Deny by default: an unknown or ungranted permission never passes.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from django.db.models import QuerySet
from rest_framework.exceptions import PermissionDenied

from apps.authz.actor import Actor
from apps.authz.catalogue import SCOPE_ALL, validate_permission


def _owner_field(model: type) -> str | None:
    return getattr(model, "OWNER_FIELD", None)


# ----------------------------------------------------------------------------- extra visibility rules
#
# Ownership scopes answer "whose records may this actor reach". Some modules add a second, orthogonal
# rule: a restricted pipeline hides its deals from members outside its teams/roles, whatever their
# scope. Modules register that rule here (from ``AppConfig.ready()``) so that it is applied by the same
# two functions every list, detail, search, export, aggregate and background job already calls, and a
# new read path cannot forget it. authz imports no module: the rule is a callback.

QueryFilter = Callable[[Actor, QuerySet], QuerySet]
ObjectFilter = Callable[[Actor, Any], bool]
_query_filters: dict[type, list[QueryFilter]] = {}
_object_filters: dict[type, list[ObjectFilter]] = {}


def register_visibility_rule(model: type, *, queryset: QueryFilter, obj: ObjectFilter) -> None:
    """Narrow every ``scope()`` over ``model`` with ``queryset`` and every ``check()`` with ``obj``."""
    if queryset not in _query_filters.setdefault(model, []):
        _query_filters[model].append(queryset)
    if obj not in _object_filters.setdefault(model, []):
        _object_filters[model].append(obj)


def _visible(actor: Actor, obj: Any) -> bool:
    return all(fn(actor, obj) for fn in _object_filters.get(type(obj), ()))


def _narrow(actor: Actor, queryset: QuerySet) -> QuerySet:
    for fn in _query_filters.get(queryset.model, ()):
        queryset = fn(actor, queryset)
    return queryset


def check(actor: Actor | None, permission: str, obj: Any | None = None) -> None:
    validate_permission(permission)
    if actor is None:
        raise PermissionDenied(detail="No active organization.", code="no_active_organization")
    scope = actor.scope_for(permission)
    if scope is None:
        raise PermissionDenied(code="permission_denied")
    if obj is not None and not _visible(actor, obj):
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
    queryset = _narrow(actor, queryset)
    if granted == SCOPE_ALL:
        return queryset
    owner_field = _owner_field(queryset.model)
    if owner_field is None:
        # Models without ownership are only reachable with the 'all' scope.
        return queryset.none()
    owners = actor.owner_ids_for(granted)
    if not owners:
        return queryset.none()
    if len(owners) == 1:
        return queryset.filter(**{f"{owner_field}_id": next(iter(owners))})
    return queryset.filter(**{f"{owner_field}_id__in": owners})


def has(actor: Actor | None, permission: str) -> bool:
    validate_permission(permission)
    return actor is not None and actor.has(permission)
