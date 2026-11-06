from __future__ import annotations

from django.apps import AppConfig
from django.db.models.signals import post_migrate


def _sync_after_migrate(sender, **kwargs) -> None:
    """Every deploy runs ``migrate``; syncing here keeps the guide in step with the release."""
    from apps.helpkb import sync

    sync.sync_global()


class HelpKBConfig(AppConfig):
    name = "apps.helpkb"
    label = "helpkb"
    verbose_name = "Help knowledge base"

    def ready(self) -> None:
        post_migrate.connect(_sync_after_migrate, sender=self, dispatch_uid="helpkb.sync_after_migrate")
