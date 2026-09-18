import os

from celery import Celery
from celery.signals import setup_logging

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("keel")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks(related_name="tasks")


@setup_logging.connect
def _use_django_logging(**kwargs):
    """Keep ``settings.LOGGING`` (structlog JSON with request ids and redaction) in workers.

    With no receiver on this signal Celery replaces the root handlers with its own plain-text formatter
    (``worker_hijack_root_logger``), so worker output was unparseable dict reprs instead of JSON events.
    """
    import logging.config

    from django.conf import settings

    logging.config.dictConfig(settings.LOGGING)


# Enqueue timestamps (for oldest-message-age metrics) and failure counters are wired through signals.
import apps.observability.signals  # noqa: E402,F401
