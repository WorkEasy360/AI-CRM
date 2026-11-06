from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.helpkb import sync


class Command(BaseCommand):
    help = "Sync the bundled help articles (apps/helpkb/kb/articles.json) into the global help tables."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--reembed", action="store_true", help="Re-embed every article, changed or not.")

    def handle(self, *args, reembed: bool = False, **options) -> None:
        stats = sync.sync_global(reembed=reembed)
        self.stdout.write(", ".join(f"{key}={value}" for key, value in stats.items()))
