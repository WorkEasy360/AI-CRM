"""Request id, extra security headers, and structured request logging."""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import Callable

import structlog
from django.http import HttpRequest, HttpResponse

log = structlog.get_logger("request")

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9\-_.]{8,64}$")
_NO_STORE_PREFIXES = ("/api/", "/_allauth/")


class RequestIDMiddleware:
    """Accept a proxy-supplied X-Request-ID (validated) or generate one; echo it back."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        incoming = request.META.get("HTTP_X_REQUEST_ID", "")
        request_id = incoming if _REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex
        request.request_id = request_id  # type: ignore[attr-defined]
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response = self.get_response(request)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
        response["X-Request-ID"] = request_id
        return response


class SecurityHeadersMiddleware:
    """Headers Django's SecurityMiddleware does not set."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        response.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
        )
        response.setdefault("X-Permitted-Cross-Domain-Policies", "none")
        if request.path.startswith(_NO_STORE_PREFIXES):
            response.setdefault("Cache-Control", "no-store")
        return response


class RequestLoggingMiddleware:
    """One structured line per request. Never logs bodies, query strings, cookies or headers."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        start = time.perf_counter()
        response = self.get_response(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        user = getattr(request, "user", None)
        actor = getattr(request, "actor", None)
        log.info(
            "http.request",
            method=request.method,
            path=request.path,
            status=response.status_code,
            duration_ms=duration_ms,
            user_id=str(user.pk) if user is not None and user.is_authenticated else None,
            organization_id=str(actor.organization.id) if actor is not None else None,
            ip=request.META.get("REMOTE_ADDR"),
        )
        return response
