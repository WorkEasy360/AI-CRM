"""Application metrics: a tiny publish API with a log backend (default) and a CloudWatch backend.

Only operational numbers go through here (queue depth, message age, task failures). Never metric
names or dimensions derived from user data.
"""

from __future__ import annotations

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


def publish(datapoints: list[dict[str, Any]]) -> None:
    """``datapoints``: ``[{"name": "QueueDepth", "value": 3, "unit": "Count", "dimensions": {"Queue": "x"}}]``.

    Publishing must never raise into a caller: a metrics outage is logged, not propagated.
    """
    if not datapoints:
        return
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
