"""The timeout relationships that cannot be allowed to drift.

These are startup checks rather than runtime assertions because every failure mode they cover is
invisible until production is already in it: a retry countdown that outlives the broker's visibility
timeout only duplicates work under load, and a migration that inherits the request path's lock timeout
only fails during a deploy against a busy table.
"""

from __future__ import annotations

import pytest
from django.test import override_settings

from apps.core import checks

pytestmark = pytest.mark.security


def _ids(issues) -> set[str]:
    return {i.id for i in issues}


# --------------------------------------------------------------------------- broker visibility


def test_shipped_configuration_is_valid():
    assert checks.check_broker_visibility_timeout(None) == []
    assert checks.check_migration_timeouts(None) == []
    assert checks.check_send_reconciliation_window(None) == []


def test_visibility_timeout_shorter_than_the_longest_task_is_an_error():
    """Redis redelivers an unacked message after visibility_timeout: a 1 h import inside a 30 min
    window is executed twice, by two workers, at the same time."""
    with override_settings(CELERY_BROKER_TRANSPORT_OPTIONS={"visibility_timeout": 1800}):
        assert "core.E002" in _ids(checks.check_broker_visibility_timeout(None))


def test_a_countdown_that_eats_the_window_is_an_error():
    """The original defect: integration sync retries backed off up to 6 h against a 2 h window."""
    with override_settings(
        CELERY_BROKER_TRANSPORT_OPTIONS={"visibility_timeout": 2 * 3600},
        CELERY_MAX_COUNTDOWN_SECONDS=6 * 3600,
    ):
        assert "core.E002" in _ids(checks.check_broker_visibility_timeout(None))


def test_missing_visibility_timeout_is_an_error():
    with override_settings(CELERY_BROKER_TRANSPORT_OPTIONS={}):
        assert "core.E001" in _ids(checks.check_broker_visibility_timeout(None))


def test_the_shipped_countdown_cap_fits_inside_the_window(settings):
    from apps.importexport.tasks import IMPORT_TIME_LIMIT

    visibility = settings.CELERY_BROKER_TRANSPORT_OPTIONS["visibility_timeout"]
    longest = max(settings.CELERY_TASK_TIME_LIMIT, IMPORT_TIME_LIMIT)
    assert longest + settings.CELERY_MAX_COUNTDOWN_SECONDS + checks.SAFETY_MARGIN_SECONDS <= visibility


# --------------------------------------------------------------------------- migrations


def test_unbounded_migration_statement_timeout_is_an_error():
    """0 means 'wait forever', which is how a stuck ALTER holds a lock and takes the site down."""
    with override_settings(DB_MIGRATION_STATEMENT_TIMEOUT_MS=0):
        assert "core.E003" in _ids(checks.check_migration_timeouts(None))


def test_unbounded_migration_lock_timeout_is_an_error():
    with override_settings(DB_MIGRATION_LOCK_TIMEOUT_MS=0):
        assert "core.E004" in _ids(checks.check_migration_timeouts(None))


def test_lock_timeout_must_expire_before_the_statement_timeout():
    with override_settings(DB_MIGRATION_LOCK_TIMEOUT_MS=900_000, DB_MIGRATION_STATEMENT_TIMEOUT_MS=600_000):
        assert "core.W002" in _ids(checks.check_migration_timeouts(None))


def test_migrations_get_more_statement_time_than_the_request_path(settings):
    """A request that hangs for 15 s is a bug; an index build that takes 5 minutes is normal work."""
    assert settings.DB_MIGRATION_STATEMENT_TIMEOUT_MS > settings.DB_STATEMENT_TIMEOUT_MS
    assert settings.DB_MIGRATION_STATEMENT_TIMEOUT_MS <= 3_600_000  # still bounded


def test_migration_lock_wait_stays_short(settings):
    """Short on purpose: during a rolling deploy, failing fast beats queueing behind a lock and
    stalling every query that arrives after it."""
    assert 0 < settings.DB_MIGRATION_LOCK_TIMEOUT_MS <= 30_000


def test_migration_mode_swaps_the_connection_options():
    """DB_MIGRATION_MODE is what the ECS migrate task sets; it must actually change the timeouts.

    Run in a subprocess: importing settings twice in-process would leave the suite talking to a
    connection configured for migrations.
    """
    import json
    import os
    import subprocess
    import sys

    script = (
        "import django, json; django.setup();"
        "from django.conf import settings as s;"
        "print(json.dumps({"
        "'options': s.DATABASES['default']['OPTIONS']['options'],"
        "'statement': s.DB_MIGRATION_STATEMENT_TIMEOUT_MS,"
        "'lock': s.DB_MIGRATION_LOCK_TIMEOUT_MS}))"
    )
    env = {**os.environ, "DB_MIGRATION_MODE": "true", "DJANGO_SETTINGS_MODULE": "config.settings.test"}
    out = subprocess.run(  # noqa: S603
        [sys.executable, "-c", script], capture_output=True, text=True, env=env, check=True, timeout=120
    )
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert f"statement_timeout={result['statement']}" in result["options"]
    assert f"lock_timeout={result['lock']}" in result["options"]


# --------------------------------------------------------------------------- send reconciliation


def test_reconciling_sooner_than_a_send_can_finish_is_flagged():
    """Reconciling a send whose worker is still alive would race the worker for the same row."""
    import datetime as dt

    with override_settings(MESSAGING_SEND_RECONCILE_AFTER=dt.timedelta(seconds=100)):
        assert "core.W001" in _ids(checks.check_send_reconciliation_window(None))
