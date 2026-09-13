"""Session helpers for the active organization. The membership id in the session is re-validated on
every request by TenantMiddleware; storing it is not itself an authorization decision."""

from __future__ import annotations

from django.http import HttpRequest

from apps.accounts.models import Membership
from apps.core.tenancy.middleware import ACTIVE_MEMBERSHIP_KEY


def set_active_membership(request: HttpRequest, membership: Membership | None) -> None:
    if membership is None:
        request.session.pop(ACTIVE_MEMBERSHIP_KEY, None)
    else:
        request.session[ACTIVE_MEMBERSHIP_KEY] = str(membership.pk)


def pick_default_membership(user) -> Membership | None:
    return (
        Membership.identity.for_user(user)
        .active()
        .filter(organization__status="active")
        .select_related("organization", "role")
        .order_by("-last_active_at", "-joined_at")
        .first()
    )
