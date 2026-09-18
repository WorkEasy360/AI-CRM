"""Liveness and readiness probes.

``security.middleware.HealthProbeMiddleware`` normalises the ``Host`` header of probe requests (load
balancers probe over plain HTTP with the target IP as ``Host``) so these views are reachable through
the normal URL routes: ``/health/live/`` and ``/health/ready/`` (``/health/`` and ``/ready/`` are aliases).

Rules: no secrets, no stack traces, no dependency details. The body is ``{"status": "ok"}`` or
``{"status": "unavailable"}``; which check failed is logged, never returned.

Two probes, two audiences, and the difference matters:

- **live** -- "is this process serving?". Touches nothing but itself. This is what the load balancer
  asks (infra/terraform/alb.tf). A liveness probe answers for the *process*, and a process does not
  stop working because a database it talks to is failing over.

- **ready** -- "can this process serve a request that needs its dependencies?". Checks the database
  and reports the cache. Used by deployment tooling and by monitoring, never by the ALB.

Why the load balancer must not use readiness: every API task shares one database. A readiness probe
makes them all fail the *same* check at the *same* moment during an RDS failover, so the ALB evicts
100% of targets over a fault the application processes played no part in. There is no healthy target
left to shift traffic to, and when the database comes back the fleet still has to pass
healthy_threshold consecutive checks before it is allowed to serve -- so a 30-second failover turns
into minutes of hard downtime. With liveness, individual requests fail with 503 while the database is
gone and succeed again the moment it returns; the recovery is as short as the fault.

That is not "ignore the database": dependency degradation is a monitoring signal
(``observability.publish_dependency_health`` plus the alarms in infra/terraform/alarms.tf), which pages
someone without taking the fleet down.
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
    """The process is up and the WSGI stack is answering. Deliberately no dependency calls."""
    return _no_store(JsonResponse({"status": "ok"}))


def check_database() -> bool:
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT 1")
            return cur.fetchone() == (1,)
    except Exception:
        log.warning("health.database_unavailable")
        return False


def check_cache() -> bool:
    try:
        cache.set("health:probe", "1", 5)
        return cache.get("health:probe") == "1"
    except Exception:
        log.warning("health.cache_unavailable")
        return False


def dependency_status() -> dict[str, bool]:
    """Both dependency checks, for the readiness view and for the metrics task."""
    return {"database": check_database(), "cache": check_cache()}


def readiness(request: HttpRequest | None = None) -> JsonResponse:
    """A request that was forwarded by a proxy (it carries ``X-Forwarded-For``) is answered without
    dependency checks when ``HEALTH_READY_INTERNAL_ONLY`` is set, so the public endpoint cannot be used to
    hammer the database; direct probes from inside the VPC never carry that header."""
    forwarded = request is not None and "HTTP_X_FORWARDED_FOR" in request.META
    if forwarded and settings.HEALTH_READY_INTERNAL_ONLY:
        return _no_store(JsonResponse({"status": "ok"}))
    status = dependency_status()
    if not status["cache"]:
        # Redis down degrades but does not stop the application: sessions fall back to the database
        # and reads go uncached (see CACHES in settings). Reported, not fatal.
        log.warning("health.ready_degraded", component="cache")
    database_ok = status["database"]
    return _no_store(
        JsonResponse({"status": "ok" if database_ok else "unavailable"}, status=200 if database_ok else 503)
    )
