"""Startup checks for configuration that is only wrong at 3am.

These run as Django system checks, so a bad combination fails ``manage.py check``, the container's
start-up and CI -- not a customer's message six weeks later.
"""

from __future__ import annotations

from typing import Any

from django.conf import settings
from django.core.checks import Error, Warning, register

# Redis is not a real message broker: it has no acknowledgements. A worker "acks" by deleting the
# message, and until it does, the broker re-delivers anything older than ``visibility_timeout``. So
# the invariant is: nothing may legitimately be in flight, or parked as a countdown, for longer than
# that window, or the broker will hand the same work to a second worker while the first is still on it.
#
#     max task time limit  +  max in-broker countdown  <  visibility_timeout
#
# The integration sync backoff reaches six hours, which is why that wait is held on the SyncJob row
# (``next_attempt_at``) and re-enqueued by ``integrations.drain`` instead of being sent as a countdown.
SAFETY_MARGIN_SECONDS = 600


def _max_task_time_limit() -> int:
    """The longest any task may legitimately run. Read from settings rather than imported from the
    task module: a core primitive must not reach up into a business module to answer a question."""
    return max(int(settings.CELERY_TASK_TIME_LIMIT or 0), int(settings.IMPORT_TASK_TIME_LIMIT))


@register()
def check_broker_visibility_timeout(app_configs: Any, **kwargs: Any) -> list[Any]:
    """The broker must not redeliver work that is still legitimately in flight."""
    issues: list[Any] = []
    options = getattr(settings, "CELERY_BROKER_TRANSPORT_OPTIONS", {}) or {}
    visibility = int(options.get("visibility_timeout") or 0)
    if not visibility:
        return [
            Error(
                "CELERY_BROKER_TRANSPORT_OPTIONS['visibility_timeout'] is not set.",
                hint="Without it Kombu defaults to one hour, which is shorter than the import time limit.",
                id="core.E001",
            )
        ]
    longest_task = _max_task_time_limit()
    countdown = int(getattr(settings, "CELERY_MAX_COUNTDOWN_SECONDS", 0))
    required = longest_task + countdown + SAFETY_MARGIN_SECONDS
    if visibility < required:
        issues.append(
            Error(
                f"Broker visibility_timeout ({visibility}s) is not longer than the longest legitimate "
                f"in-flight period ({longest_task}s task limit + {countdown}s max countdown + "
                f"{SAFETY_MARGIN_SECONDS}s margin = {required}s).",
                hint=(
                    "Redis redelivers an unacked message after visibility_timeout, so a slow task or a "
                    "long countdown would be executed twice. Raise CELERY_VISIBILITY_TIMEOUT, shorten the "
                    "task time limit, or hold long waits on the row instead of as a countdown."
                ),
                id="core.E002",
            )
        )
    return issues


@register()
def check_send_reconciliation_window(app_configs: Any, **kwargs: Any) -> list[Any]:
    """A send must not be reconciled while its own worker could still be working on it."""
    reconcile_after = getattr(settings, "MESSAGING_SEND_RECONCILE_AFTER", None)
    if reconcile_after is None:
        return []
    send_limit = 90  # messaging.send_* hard time_limit
    if reconcile_after.total_seconds() <= send_limit * 2:
        return [
            Warning(
                f"MESSAGING_SEND_RECONCILE_AFTER ({reconcile_after}) is close to the send task's hard "
                f"time limit ({send_limit}s).",
                hint="A slow but living send could be reconciled underneath itself. Allow more headroom.",
                id="core.W001",
            )
        ]
    return []


@register()
def check_migration_timeouts(app_configs: Any, **kwargs: Any) -> list[Any]:
    """Migration timeouts must be bounded: generous enough to finish, never unlimited."""
    issues: list[Any] = []
    statement = int(getattr(settings, "DB_MIGRATION_STATEMENT_TIMEOUT_MS", 0))
    lock = int(getattr(settings, "DB_MIGRATION_LOCK_TIMEOUT_MS", 0))
    if statement <= 0:
        issues.append(
            Error(
                "DB_MIGRATION_STATEMENT_TIMEOUT_MS must be a positive number of milliseconds.",
                hint="0 means 'wait forever', which is how a migration takes an application down.",
                id="core.E003",
            )
        )
    if lock <= 0:
        issues.append(
            Error(
                "DB_MIGRATION_LOCK_TIMEOUT_MS must be a positive number of milliseconds.",
                hint=(
                    "A migration that queues indefinitely for a lock blocks every query behind it. "
                    "Failing fast and retrying is always the safer deployment."
                ),
                id="core.E004",
            )
        )
    if statement and lock and lock >= statement:
        issues.append(
            Warning(
                f"DB_MIGRATION_LOCK_TIMEOUT_MS ({lock}) is not shorter than "
                f"DB_MIGRATION_STATEMENT_TIMEOUT_MS ({statement}).",
                hint="The lock wait should expire first so a blocked migration reports the lock, not a timeout.",
                id="core.W002",
            )
        )
    return issues
