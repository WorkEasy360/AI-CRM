"""Throttled replacement for ``allauth.usersessions.middleware.UserSessionsMiddleware``.

allauth's middleware calls ``UserSession.objects.create_from_request()`` on every authenticated
request: a SAVEPOINT, a SELECT, an UPDATE of ``last_seen_at`` and a COMMIT before the view even
runs. The "last seen" column only needs minute-level precision, so this version records activity
at most once per ``USERSESSIONS_ACTIVITY_INTERVAL`` seconds per session, and immediately whenever
the client (IP or user agent) changes so the ``session_client_changed`` signal still fires.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Callable

from allauth.usersessions import app_settings
from allauth.usersessions.models import UserSession
from django.conf import settings
from django.http import HttpRequest, HttpResponse

_SEEN_KEY = "_usersession_seen"


def _client_fingerprint(request: HttpRequest) -> str:
    from allauth.account.adapter import get_adapter

    ip = get_adapter().get_client_ip(request) or ""
    ua = request.META.get("HTTP_USER_AGENT", "")
    return hashlib.sha256(f"{ip}\n{ua}".encode()).hexdigest()[:16]


class ThrottledUserSessionsMiddleware:
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
