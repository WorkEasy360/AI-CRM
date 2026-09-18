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


def enforce_csrf(request: Request) -> None:
    """Apply Django's CSRF check to a request DRF would not check (an anonymous POST that signs in)."""
    from django.http import HttpResponse
    from rest_framework.authentication import CSRFCheck
    from rest_framework.exceptions import PermissionDenied

    check = CSRFCheck(lambda _request: HttpResponse())
    check.process_request(request._request)
    reason = check.process_view(request._request, None, (), {})  # type: ignore[arg-type]  # as DRF does
    if reason:
        raise PermissionDenied(f"CSRF Failed: {reason}")
