"""Queue-depth and oldest-message-age metrics, published every 30 seconds by Celery beat.

These are the signals the worker autoscaling policies act on (infra/terraform/autoscaling.tf); CPU is
a poor proxy for backlog. The task reads the broker directly (LLEN + the oldest message's enqueue
header) and never touches tenant data, so it runs as a plain ``shared_task``.
"""

from __future__ import annotations

import json
import time
from typing import Any

import structlog
from celery import shared_task
from django.conf import settings

from apps.observability import metrics
from apps.observability.signals import ENQUEUED_AT_HEADER

log = structlog.get_logger(__name__)


def _broker() -> Any:
    import redis

    return redis.Redis.from_url(
        settings.CELERY_BROKER_URL, socket_connect_timeout=2, socket_timeout=2, decode_responses=False
    )


def _oldest_age_seconds(client: Any, queue: str, now: float) -> float:
    """Celery LPUSHes and BRPOPs, so the oldest message sits at the tail of the list."""
    raw = client.lindex(queue, -1)
    if not raw:
        return 0.0
    try:
        message = json.loads(raw)
        enqueued = float((message.get("headers") or {}).get(ENQUEUED_AT_HEADER, 0.0))
    except (ValueError, TypeError, AttributeError):
        return 0.0
    return max(0.0, now - enqueued) if enqueued else 0.0


def collect() -> list[dict[str, Any]]:
    client = _broker()
    now = time.time()
    points: list[dict[str, Any]] = []
    for queue in settings.CELERY_TASK_QUEUES:
        depth = int(client.llen(queue))
        age = _oldest_age_seconds(client, queue, now) if depth else 0.0
        points.append({"name": "QueueDepth", "value": depth, "unit": "Count", "dimensions": {"Queue": queue}})
        points.append(
            {
                "name": "OldestMessageAgeSeconds",
                "value": round(age, 1),
                "unit": "Seconds",
                "dimensions": {"Queue": queue},
            }
        )
    return points


@shared_task(name="observability.publish_celery_metrics", ignore_result=True, soft_time_limit=20, time_limit=25)
def publish_celery_metrics() -> int:
    try:
        points = collect()
    except Exception:
        log.warning("metrics.broker_unavailable")
        return 0
    metrics.publish(points)
    return len(points)
