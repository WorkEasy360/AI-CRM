"""Application metrics: a tiny publish API with a log backend (default) and a CloudWatch backend.

Only operational numbers go through here (queue depth, message age, task failures). Never metric
names or dimensions derived from user data.
"""

from __future__ import annotations

import os
import queue
import threading
from typing import Any

import structlog
from django.conf import settings

log = structlog.get_logger(__name__)

_cloudwatch_client: Any = None
_client_lock = threading.Lock()


def _client() -> Any:
    global _cloudwatch_client
    if _cloudwatch_client is None:
        with _client_lock:
            if _cloudwatch_client is None:
                import boto3
                from botocore.config import Config

                _cloudwatch_client = boto3.client(
                    "cloudwatch",
                    region_name=settings.AWS_REGION,
                    config=Config(connect_timeout=2, read_timeout=5, retries={"max_attempts": 2}),
                )
    return _cloudwatch_client


# Datapoint batches waiting for the background publisher (per process; see ``publish(wait=False)``).
BACKGROUND_QUEUE_SIZE = 1000
_background: queue.Queue[list[dict[str, Any]]] | None = None
_background_pid = 0
_background_lock = threading.Lock()


def publish(datapoints: list[dict[str, Any]], *, wait: bool = True) -> None:
    """``datapoints``: ``[{"name": "QueueDepth", "value": 3, "unit": "Count", "dimensions": {"Queue": "x"}}]``.

    Publishing must never raise into a caller: a metrics outage is logged, not propagated.

    ``wait=False`` is for web request threads. With the CloudWatch backend a publish is an AWS API call
    (connect 2 s + read 5 s, two attempts: up to ~14 s when CloudWatch is slow); it is handed to a
    per-process background thread instead, and dropped (logged) if that thread has fallen
    ``BACKGROUND_QUEUE_SIZE`` batches behind. The log backend is cheap and always runs inline.
    """
    if not datapoints:
        return
    if not wait and settings.METRICS_BACKEND == "cloudwatch":
        if not _enqueue(datapoints):
            log.warning("metrics.background_queue_full", count=len(datapoints))
        return
    _publish_now(datapoints)


def _enqueue(datapoints: list[dict[str, Any]]) -> bool:
    global _background, _background_pid
    pid = os.getpid()
    with _background_lock:
        # Keyed by pid: a forked worker (gunicorn, Celery prefork) inherits the queue but not the thread.
        if _background is None or _background_pid != pid:
            _background = queue.Queue(maxsize=BACKGROUND_QUEUE_SIZE)
            _background_pid = pid
            threading.Thread(target=_drain, args=(_background,), name="metrics-publisher", daemon=True).start()
        pending = _background
    try:
        pending.put_nowait(datapoints)
    except queue.Full:
        return False
    return True


def _drain(pending: queue.Queue[list[dict[str, Any]]]) -> None:
    while True:
        _publish_now(pending.get())
        pending.task_done()


def _publish_now(datapoints: list[dict[str, Any]]) -> None:
    backend = settings.METRICS_BACKEND
    if backend == "cloudwatch":
        try:
            metric_data = [
                {
                    "MetricName": d["name"],
                    "Value": float(d["value"]),
                    "Unit": d.get("unit", "Count"),
                    "Dimensions": [{"Name": k, "Value": str(v)} for k, v in (d.get("dimensions") or {}).items()],
                }
                for d in datapoints
            ]
            # CloudWatch accepts at most 1000 datapoints per call; we stay far below that.
            for start in range(0, len(metric_data), 500):
                _client().put_metric_data(
                    Namespace=settings.METRICS_NAMESPACE, MetricData=metric_data[start : start + 500]
                )
            return
        except Exception:
            log.warning("metrics.cloudwatch_publish_failed", count=len(datapoints))
            # fall through to the log backend so the numbers are not lost
    for d in datapoints:
        log.info("metric", name=d["name"], value=d["value"], unit=d.get("unit", "Count"), **(d.get("dimensions") or {}))
