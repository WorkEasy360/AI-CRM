from __future__ import annotations

from django.apps import AppConfig


class IntegrationsConfig(AppConfig):
    name = "apps.integrations"
    label = "integrations"
    verbose_name = "Integration Hub"

    def ready(self) -> None:
        from apps.integrations import schema, signals  # noqa: F401  (schema registers the OpenAPI extension)

        signals.connect()
