"""Session middleware for the accounts app.

``ThrottledUserSessionsMiddleware`` is a cheaper replacement for allauth's activity tracker.
``AutoLoginMiddleware`` is the development-only switch that opens the CRM without a sign-in page.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Callable

import structlog
from allauth.usersessions import app_settings
from allauth.usersessions.models import UserSession
from django.conf import settings
from django.contrib.auth import login as auth_login
from django.db import IntegrityError, transaction
from django.http import HttpRequest, HttpResponse

log = structlog.get_logger(__name__)

_SEEN_KEY = "_usersession_seen"


def _client_fingerprint(request: HttpRequest) -> str:
    from allauth.account.adapter import get_adapter

    ip = get_adapter().get_client_ip(request) or ""
    ua = request.META.get("HTTP_USER_AGENT", "")
    return hashlib.sha256(f"{ip}\n{ua}".encode()).hexdigest()[:16]


class ThrottledUserSessionsMiddleware:
    """Throttled replacement for ``allauth.usersessions.middleware.UserSessionsMiddleware``.

    allauth's middleware calls ``UserSession.objects.create_from_request()`` on every authenticated
    request: a SAVEPOINT, a SELECT, an UPDATE of ``last_seen_at`` and a COMMIT before the view even
    runs. The "last seen" column only needs minute-level precision, so this version records activity
    at most once per ``USERSESSIONS_ACTIVITY_INTERVAL`` seconds per session, and immediately whenever
    the client (IP or user agent) changes so the ``session_client_changed`` signal still fires.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if (
            app_settings.TRACK_ACTIVITY
            and hasattr(request, "session")
            and request.session.session_key
            and hasattr(request, "user")
            and request.user.is_authenticated
            and self._should_track(request)
        ):
            UserSession.objects.create_from_request(request)
        return self.get_response(request)

    @staticmethod
    def _should_track(request: HttpRequest) -> bool:
        interval = getattr(settings, "USERSESSIONS_ACTIVITY_INTERVAL", 300)
        fingerprint = _client_fingerprint(request)
        now = int(time.time())
        seen = request.session.get(_SEEN_KEY)
        if isinstance(seen, list) and len(seen) == 2 and seen[1] == fingerprint and now - int(seen[0]) < interval:
            return False
        request.session[_SEEN_KEY] = [now, fingerprint]
        return True


def auto_login_enabled() -> bool:
    """True only when the flag is set *and* the environment is not a deployed one."""
    if not getattr(settings, "AUTO_LOGIN_ENABLED", False):
        return False
    if getattr(settings, "ENVIRONMENT", "") in {"production", "staging"}:
        return False
    return bool(getattr(settings, "AUTO_LOGIN_EMAIL", ""))


def _auto_login_user():
    """The single account the CRM opens as, created on first use. Idempotent and race-safe."""
    from allauth.account.models import EmailAddress

    from apps.accounts.models import User

    email = settings.AUTO_LOGIN_EMAIL.strip().lower()
    user = User.objects.filter(email__iexact=email).first()
    if user is not None:
        return user
    try:
        with transaction.atomic():
            # No usable password: the account exists for this middleware only and cannot be
            # signed into through the password flow.
            user = User.objects.create_user(email=email, password=None, first_name=settings.AUTO_LOGIN_NAME)
            EmailAddress.objects.create(user=user, email=user.email, primary=True, verified=True)
            return user
    except IntegrityError:
        # A concurrent request won the race; use the row it committed.
        return User.objects.filter(email__iexact=email).first()


class AutoLoginMiddleware:
    """Open the CRM without a sign-in page by signing every visitor in as one fixed account.

    This is a development convenience, not an authentication mechanism: while it is on, anyone
    who can reach the server *is* the auto-login user. It is therefore double-gated -- off unless
    ``AUTO_LOGIN_ENABLED`` is set, and refused outright when ``ENVIRONMENT`` is production or
    staging (``config.settings.prod`` additionally forces the flag off and raises if the
    environment asks for it).

    Nothing below it is weakened. The session it creates is an ordinary Django session for an
    ordinary user, the active membership comes from ``bootstrap_session`` exactly as it would
    after a real login, and TenantMiddleware, RLS and every permission check still apply to it.
    """

    #: Probes and assets never need a session; signing in there would only create junk sessions.
    SKIP_PREFIXES = ("/health/", "/ready/", "/static/", "/media/")
    #: Signing in rotates the CSRF token, and CsrfViewMiddleware validates the request *after*
    #: this one runs, so an unsafe method would fail its own CSRF check. The browser always reads
    #: the session before it writes anything, so the session exists by the time a write arrives.
    SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
    BACKEND = "allauth.account.auth_backends.AuthenticationBackend"

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        # Re-read per request rather than caching: two cheap getattr calls, and the gate then
        # cannot be left stale by a settings override.
        if auto_login_enabled() and self._needs_login(request):
            self._sign_in(request)
        return self.get_response(request)

    def _needs_login(self, request: HttpRequest) -> bool:
        if request.method not in self.SAFE_METHODS:
            return False
        if request.path.startswith(self.SKIP_PREFIXES):
            return False
        # An API credential (Authorization: Bearer keel_...) already authenticated this request;
        # never replace a machine identity with the auto-login user.
        if getattr(request, "integration_actor", None) is not None:
            return False
        user = getattr(request, "user", None)
        return user is not None and not user.is_authenticated

    def _sign_in(self, request: HttpRequest) -> None:
        from apps.accounts.services import bootstrap_session
        from apps.audit import actions
        from apps.audit import service as audit

        with transaction.atomic():
            user = _auto_login_user()
            if user is None or not user.is_active:
                log.warning("accounts.auto_login_unavailable", email=settings.AUTO_LOGIN_EMAIL)
                return
            auth_login(request, user, backend=self.BACKEND)
            membership = bootstrap_session(request, user)
            # A sign-in is a security-relevant event even when it is automatic.
            audit.record(
                actions.AUTH_LOGIN,
                request=request,
                user=user,
                organization_id=membership.organization_id if membership else None,
                metadata={"method": "auto_login"},
            )
