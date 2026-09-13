"""Typed request for views that run inside a tenant context (TenantMiddleware sets ``request.actor``)."""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from rest_framework.request import Request

if TYPE_CHECKING:
    from apps.accounts.models import User
    from apps.authz.actor import Actor


class ActorRequest(Request):
    actor: Actor


def authenticated_user(request: Request) -> User:
    """Narrow ``request.user`` after a permission class has guaranteed authentication."""
    return cast("User", request.user)
