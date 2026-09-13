"""Gunicorn production configuration (``gunicorn -c config/gunicorn.py config.wsgi:application``).

Worker model: ``gthread``. A page load fires several API calls in parallel and most request time is
spent waiting on PostgreSQL/Redis, so threads multiply throughput per vCPU without the memory cost of
extra processes. Tenant context lives in a ContextVar and database context is transaction-local
(``SET LOCAL``), so threads are safe.

Sizing is environment-driven and intentionally NOT a formula over CPU count: a Fargate task gets a fixed
vCPU allocation and the right number is measured (see docs/operations/load-testing.md). Defaults suit a
1 vCPU / 2 GB task: 2 processes x 4 threads = 8 concurrent requests and at most
``GUNICORN_WORKERS x DB_POOL_MAX_SIZE`` database connections per task.
"""

from __future__ import annotations

import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
worker_class = "gthread"
workers = int(os.environ.get("GUNICORN_WORKERS", "2"))
threads = int(os.environ.get("GUNICORN_THREADS", "4"))
worker_connections = int(os.environ.get("GUNICORN_WORKER_CONNECTIONS", "200"))

# ``timeout`` guards a worker whose main loop stopped heart-beating (it is not a per-request limit for
# gthread). Per-request limits are the database statement timeout, the cache socket timeout and the
# load balancer idle timeout; anything longer than those belongs in Celery.
timeout = int(os.environ.get("GUNICORN_TIMEOUT", "30"))
# On SIGTERM (ECS stop, rolling deploy) stop accepting, finish in-flight requests, then exit.
graceful_timeout = int(os.environ.get("GUNICORN_GRACEFUL_TIMEOUT", "30"))
# Must exceed the load balancer's idle timeout (ALB default 60s) or the ALB may reuse a connection the
# worker has just closed and answer the client with a 502.
keepalive = int(os.environ.get("GUNICORN_KEEPALIVE", "75"))

# Request-line and header limits reject oversized or malformed requests before Django sees them.
limit_request_line = 8190
limit_request_fields = 100
limit_request_field_size = 8190

# Worker recycling is opt-in: set GUNICORN_MAX_REQUESTS when a memory-growth pattern is observed.
max_requests = int(os.environ.get("GUNICORN_MAX_REQUESTS", "0"))
max_requests_jitter = int(os.environ.get("GUNICORN_MAX_REQUESTS_JITTER", "0")) or max_requests // 10

# Only the load balancer can reach the task (security group), so its X-Forwarded-* headers are trusted.
forwarded_allow_ips = os.environ.get("GUNICORN_FORWARDED_ALLOW_IPS", "*")
proxy_allow_ips = forwarded_allow_ips

# Import the application once in the master and fork: less memory per worker and import errors fail
# the container start instead of a worker crash loop.
preload_app = True

# Structured per-request logs come from security.middleware.RequestLoggingMiddleware (request id, user,
# organization, duration). Gunicorn's own access log is redundant in production; enable for debugging.
accesslog = "-" if os.environ.get("GUNICORN_ACCESS_LOG", "").lower() in {"1", "true", "yes"} else None
errorlog = "-"
loglevel = os.environ.get("GUNICORN_LOG_LEVEL", "info")
capture_output = True


def post_fork(server, worker):
    """Never share database or cache connections between the master and its workers."""
    from django.db import connections

    connections.close_all()


def worker_exit(server, worker):
    from django.db import connections

    connections.close_all()
