from __future__ import annotations

from django.apps import AppConfig


class RagConfig(AppConfig):
    name = "apps.rag"
    label = "rag"
    verbose_name = "Knowledge index"

    def ready(self) -> None:
        from apps.rag import signals

        signals.connect()
