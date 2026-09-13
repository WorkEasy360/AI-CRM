"""Celery signal hooks: stamp enqueue time on every message and count task failures."""

from __future__ import annotations

import time
from typing import Any

import structlog
from celery.signals import before_task_publish, task_failure

from apps.observability import metrics

log = structlog.get_logger(__name__)

ENQUEUED_AT_HEADER = "keel_enqueued_at"


@before_task_publish.connect
def _stamp_enqueued_at(headers: dict[str, Any] | None = None, **kwargs: Any) -> None:
    """Record when a message entered the queue so the metrics task can compute the oldest message age."""
    if headers is not None:
        headers.setdefault(ENQUEUED_AT_HEADER, time.time())


@task_failure.connect
def _count_failure(sender: Any = None, **kwargs: Any) -> None:
    name = getattr(sender, "name", "unknown")
    queue = "unknown"
    request = getattr(sender, "request", None)
    delivery = getattr(request, "delivery_info", None) or {}
    if isinstance(delivery, dict):
        queue = delivery.get("routing_key") or queue
    log.warning("celery.task_failed", task=name, queue=queue)
    metrics.publish([{"name": "TaskFailures", "value": 1, "unit": "Count", "dimensions": {"Queue": queue}}])
