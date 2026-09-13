"""Liveness and readiness probes.

``security.middleware.HealthProbeMiddleware`` normalises the ``Host`` header of probe requests (load
balancers probe over plain HTTP with the target IP as ``Host``) so these views are reachable through
the normal URL routes: ``/health/live/`` and ``/health/ready/`` (``/health/`` and ``/ready/`` are aliases).

Rules: no secrets, no stack traces, no dependency details. The body is ``{"status": "ok"}`` or
``{"status": "unavailable"}``; which check failed is logged, never returned.

- live:  the process accepts requests (no dependency calls).
- ready: the process can serve traffic. The database is required; the cache is reported but not
  required because the application degrades to database-backed sessions and uncached reads when
  Redis is unavailable (see ``CACHES`` in settings).
"""

from __future__ import annotations

import structlog
from django.conf import settings
from django.core.cache import cache
from django.db import connection
from django.http import HttpRequest, JsonResponse

log = structlog.get_logger(__name__)

LIVE_PATHS = frozenset({"/health/live/", "/health/live", "/health/", "/health"})
READY_PATHS = frozenset({"/health/ready/", "/health/ready", "/ready/", "/ready"})


def _no_store(response: JsonResponse) -> JsonResponse:
    response["Cache-Control"] = "no-store"
    return response


def liveness(request: HttpRequest | None = None) -> JsonResponse:
    return _no_store(JsonResponse({"status": "ok"}))


def _check_database() -> bool:
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT 1")
            return cur.fetchone() == (1,)
    except Exception:
        log.warning("health.database_unavailable")
        return False


def _check_cache() -> bool:
    try:
        cache.set("health:probe", "1", 5)
        return cache.get("health:probe") == "1"
    except Exception:
        log.warning("health.cache_unavailable")
        return False


def readiness(request: HttpRequest | None = None) -> JsonResponse:
    """A request that was forwarded by a proxy (it carries ``X-Forwarded-For``) is answered without
    dependency checks when ``HEALTH_READY_INTERNAL_ONLY`` is set, so the public endpoint cannot be used to
    hammer the database; the load balancer's own probes never carry that header."""
    forwarded = request is not None and "HTTP_X_FORWARDED_FOR" in request.META
    if forwarded and settings.HEALTH_READY_INTERNAL_ONLY:
        return _no_store(JsonResponse({"status": "ok"}))
    database_ok = _check_database()
    if not _check_cache():
        log.warning("health.ready_degraded", component="cache")
    return _no_store(
        JsonResponse({"status": "ok" if database_ok else "unavailable"}, status=200 if database_ok else 503)
    )
