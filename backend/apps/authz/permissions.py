"""DRF permission classes. The project default is DenyAll; views opt in explicitly."""

from __future__ import annotations

from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts.workeasy360 import entitlement
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
        # Workeasy360 entitlement: no tenant data once the organization's access to WorkEasy CRM has ended, and
        # no writes while it is read-only (re-checked on Workeasy360's cadence, never per request). Asked per
        # person where the session has a Workeasy360 identity: a removed member or seat ends their access alone.
        write = request.method not in SAFE_METHODS and getattr(view, "action", None) not in getattr(
            view, "entitlement_read_actions", ()
        )
        entitlement.require(
            actor.organization,
            write=write,
            subject=actor.federated_subject,
            # An API credential acts for the organization, not for a signed-in person: asked at organization level.
            person_required=getattr(request, "integration_actor", None) is None,
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
