"""Request id, client IP behind trusted proxies, health probes, extra security headers, request logging."""

from __future__ import annotations

import os
import re
import socket
import time
import uuid
from collections.abc import Callable

import structlog
from django.conf import settings
from django.http import HttpRequest, HttpResponse

log = structlog.get_logger("request")

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9\-_.]{8,64}$")
_TRACE_ROOT_RE = re.compile(r"Root=([A-Za-z0-9\-]{1,64})")
_NO_STORE_PREFIXES = ("/api/", "/_allauth/")


def _probe_host() -> str:
    """A host name that passes ALLOWED_HOSTS, so probes flow through the normal middleware stack."""
    for host in settings.ALLOWED_HOSTS:
        if host == "*":
            break
        return host.lstrip(".")
    return "localhost"


class HealthProbeMiddleware:
    """Make load-balancer probes to ``/health/live/`` and ``/health/ready/`` routable.

    Probes arrive over plain HTTP with the target IP as ``Host`` and no forwarded headers; without this,
    ``ALLOWED_HOSTS`` would answer 400 and no target could ever become healthy. Only the ``Host`` header is
    normalised for exact probe paths; the request still passes every other middleware (security headers,
    request id, logging) and ``SECURE_REDIRECT_EXEMPT`` keeps the HTTPS redirect away from it.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        from apps.core.health import LIVE_PATHS, READY_PATHS

        if request.method in {"GET", "HEAD"} and request.path in LIVE_PATHS | READY_PATHS:
            request.META["HTTP_HOST"] = _probe_host()
        return self.get_response(request)


class ClientIPMiddleware:
    """Set ``REMOTE_ADDR`` to the real client address when running behind a fixed number of proxies.

    ``TRUSTED_PROXY_COUNT`` is the number of proxy hops that *append* to ``X-Forwarded-For`` in front of
    this process (CloudFront + ALB = 2, ALB only = 1, none = 0). The address is taken that many entries
    from the right, so a client cannot spoof it by sending its own ``X-Forwarded-For`` header: every
    trusted hop appends the peer it actually talked to. Throttles (DRF, allauth), audit logs and the
    request log all read ``REMOTE_ADDR``.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        hops = settings.TRUSTED_PROXY_COUNT
        if hops > 0:
            forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
            if forwarded:
                addresses = [a.strip() for a in forwarded.split(",") if a.strip()]
                # Fewer entries than trusted hops means the request did not come through the expected
                # chain; keep the peer address (the proxy) rather than trust whatever the client sent.
                if len(addresses) >= hops:
                    request.META["REMOTE_ADDR"] = addresses[-hops]
        return self.get_response(request)


class RequestIDMiddleware:
    """Accept a proxy-supplied X-Request-ID (validated) or generate one; echo it back.

    An ALB/CloudFront ``X-Amzn-Trace-Id`` root segment is bound to the log context as ``trace_id`` so a
    request can be correlated with the load balancer's access logs.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        incoming = request.META.get("HTTP_X_REQUEST_ID", "")
        request_id = incoming if _REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex
        request.request_id = request_id  # type: ignore[attr-defined]
        bound = {"request_id": request_id}
        trace = _TRACE_ROOT_RE.search(request.META.get("HTTP_X_AMZN_TRACE_ID", ""))
        if trace:
            bound["trace_id"] = trace.group(1)
        structlog.contextvars.bind_contextvars(**bound)
        try:
            response = self.get_response(request)
        finally:
            structlog.contextvars.unbind_contextvars(*bound.keys())
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


_HOSTNAME = socket.gethostname()


def _instance() -> str:
    # Computed per call: with gunicorn's preload_app the module is imported in the master before forking,
    # so a module-level constant would carry the master's pid into every worker.
    return f"{_HOSTNAME}:{os.getpid()}"


class RequestLoggingMiddleware:
    """One structured line per request. Never logs bodies, query strings, cookies or headers.

    Requests slower than ``SLOW_REQUEST_MS`` are logged at WARNING so they can drive an alarm.
    ``EXPOSE_INSTANCE_HEADER`` (load-test environments only) adds ``X-Instance: host:pid`` so a
    multi-instance session test can prove requests were spread across processes.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        start = time.perf_counter()
        response = self.get_response(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        user = getattr(request, "user", None)
        actor = getattr(request, "actor", None)
        slow = duration_ms >= settings.SLOW_REQUEST_MS
        (log.warning if slow else log.info)(
            "http.slow_request" if slow else "http.request",
            method=request.method,
            path=request.path,
            status=response.status_code,
            duration_ms=duration_ms,
            user_id=str(user.pk) if user is not None and user.is_authenticated else None,
            organization_id=str(actor.organization.id) if actor is not None else None,
            ip=request.META.get("REMOTE_ADDR"),
        )
        if settings.EXPOSE_INSTANCE_HEADER:
            response["X-Instance"] = _instance()
        return response
