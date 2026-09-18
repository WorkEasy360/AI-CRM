"""Resolve the tenant for every HTTP request from the session and bind it for the request lifetime.

Runs after authentication. Wraps the request in a database transaction so that the RLS settings
(``SET LOCAL``) apply to everything the view does. Also enforces the idle-session timeout and the
server-side session revocation list.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, cast

import structlog
from django.conf import settings
from django.db import connections, transaction
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils import timezone

from apps.core.tenancy.context import TenantContext, apply_db_context, bind_context, get_context

if TYPE_CHECKING:
    from apps.accounts.models import User
    from apps.authz.actor import Actor

log = structlog.get_logger(__name__)

ACTIVE_MEMBERSHIP_KEY = "active_membership_id"
LAST_SEEN_KEY = "last_seen_at"
_LAST_SEEN_WRITE_INTERVAL = 300  # seconds


class TenantMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        request.actor = None  # type: ignore[attr-defined]
        # When this is the outermost transaction, COMMIT/ROLLBACK resets every SET LOCAL by itself;
        # the explicit restore below is only needed when an enclosing transaction (tests) outlives it.
        nested = connections["default"].in_atomic_block
        with transaction.atomic():
            previous = get_context()
            try:
                return self._handle(request)
            finally:
                # Whatever the view (or a login signal) set at the DB level, restore the outer state.
                # One round trip here instead of one per nested bind_context() level in _handle().
                if nested:
                    apply_db_context(previous)

    def _handle(self, request: HttpRequest) -> HttpResponse:
        integration_actor = getattr(request, "integration_actor", None)
        if integration_actor is not None:
            # Authenticated by apps.integrations.machine_auth (API credential, no session): the tenant
            # comes from the credential's organization, never from the request.
            request.actor = integration_actor  # type: ignore[attr-defined]
            ctx = TenantContext(
                organization_id=integration_actor.organization.id,
                user_id=integration_actor.user.pk,
                membership_id=integration_actor.membership.id,
            )
            with bind_context(ctx, restore_db=False):
                return self.get_response(request)
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return self.get_response(request)
        if self._session_expired(request):
            request.session.flush()
            return JsonResponse(
                {"type": "session_expired", "title": "Session expired", "status": 401},
                status=401,
            )
        # Identity-level context: lets the user see their own memberships/organizations (RLS user
        # policies) but grants no tenant scope. Nested contexts restore to this on exit.
        with bind_context(TenantContext(organization_id=None, user_id=user.pk), restore_db=False):
            actor = self._resolve_actor(request)
            if actor is None:
                return self.get_response(request)
            request.actor = actor  # type: ignore[attr-defined]
            ctx = TenantContext(
                organization_id=actor.organization.id,
                user_id=user.pk,
                membership_id=actor.membership.id,
            )
            with bind_context(ctx, restore_db=False):
                return self.get_response(request)

    @staticmethod
    def _session_expired(request: HttpRequest) -> bool:
        idle = getattr(settings, "SESSION_IDLE_TIMEOUT_SECONDS", 0)
        if not idle:
            return False
        now = timezone.now()
        last_seen = request.session.get(LAST_SEEN_KEY)
        if last_seen is not None:
            try:
                last_seen_dt = datetime.fromisoformat(last_seen)
            except ValueError:
                last_seen_dt = None
            if last_seen_dt is not None and (now - last_seen_dt).total_seconds() > idle:
                return True
            if last_seen_dt is not None and (now - last_seen_dt).total_seconds() < _LAST_SEEN_WRITE_INTERVAL:
                return False
        request.session[LAST_SEEN_KEY] = now.isoformat()
        return False

    @staticmethod
    def _resolve_actor(request: HttpRequest) -> Actor | None:
        """Load the active membership recorded in the session and build the Actor.

        The membership id in the session is validated on every request against the database:
        it must belong to the authenticated user, be active, and its organization must be active.
        """
        from apps.accounts.models import Membership, Organization
        from apps.authz.actor import build_actor

        user = cast("User", request.user)
        raw = request.session.get(ACTIVE_MEMBERSHIP_KEY)
        if not raw:
            return None
        try:
            membership_id = uuid.UUID(str(raw))
        except ValueError:
            request.session.pop(ACTIVE_MEMBERSHIP_KEY, None)
            return None
        membership = (
            Membership.identity.for_user(user)
            .active()
            .filter(pk=membership_id, organization__status=Organization.Status.ACTIVE)
            .select_related("organization", "role", "user")
            .first()
        )
        if membership is None:
            request.session.pop(ACTIVE_MEMBERSHIP_KEY, None)
            log.warning("tenancy.stale_membership_in_session", user_id=str(user.pk))
            return None
        return build_actor(membership)
