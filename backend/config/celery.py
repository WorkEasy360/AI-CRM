import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

app = Celery("keel")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks(related_name="tasks")

# Enqueue timestamps (for oldest-message-age metrics) and failure counters are wired through signals.
import apps.observability.signals  # noqa: E402,F401
