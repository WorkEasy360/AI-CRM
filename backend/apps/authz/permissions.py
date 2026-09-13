"""DRF permission classes. The project default is DenyAll; views opt in explicitly."""

from __future__ import annotations

from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import BasePermission

from apps.authz.catalogue import validate_permission


class DenyAll(BasePermission):
    """Project-wide default: a view that forgets to declare permissions is unreachable."""

    def has_permission(self, request, view) -> bool:
        return False


class IsAuthenticatedUser(BasePermission):
    """Authenticated user, no organization required (org creation, session info)."""

    def has_permission(self, request, view) -> bool:
        return bool(request.user and request.user.is_authenticated)


class RequirePermissions(BasePermission):
    """Resolve the required permission from ``view.permission_map`` and check it against the actor.

    Viewsets map by ``action``; plain APIViews map by HTTP method. A missing mapping denies.
    """

    def has_permission(self, request, view) -> bool:
        if not (request.user and request.user.is_authenticated):
            return False
        actor = getattr(request, "actor", None)
        if actor is None:
            return False
        if actor.mfa_required:
            # Organization policy: no tenant data until the user has enrolled a second factor.
            # Session and allauth endpoints stay reachable so enrolment is possible.
            raise PermissionDenied(
                detail="Multi-factor authentication is required by your organization.", code="mfa_required"
            )
        permission = resolve_required_permission(request, view)
        if permission is None:
            return False
        return actor.has(permission)


def resolve_required_permission(request, view) -> str | None:
    mapping = getattr(view, "permission_map", None) or {}
    action = getattr(view, "action", None)
    key = action if action else request.method
    if key == "OPTIONS":
        return None
    permission = mapping.get(key)
    if permission is None:
        return None
    return validate_permission(permission)
