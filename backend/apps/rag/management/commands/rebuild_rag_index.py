"""Build or rebuild the knowledge index for one organization, or for all of them.

Safe to run on a live system and safe to run twice:

- **Tenant scoped.** Every organization is processed inside its own tenant context, so the scoped
  managers and RLS apply exactly as they do in a request. ``--organization`` limits it to one.
- **Idempotent and resume-safe.** Work is queued through the same outbox the CRM writes use, and the
  worker skips any source whose ``content_hash`` and embedding model are unchanged. Re-running after
  an interruption costs queries, not embeddings.
- **Incremental.** Nothing is dropped first. The index is never empty part-way through a rebuild, so
  the assistant keeps answering while it runs.
- **Rate limited.** ``--batch`` bounds how many sources are queued per pause, so a rebuild of a large
  workspace cannot saturate the embedding provider or the queue.

    python manage.py rebuild_rag_index --organization <uuid>
    python manage.py rebuild_rag_index --all --source-type note --source-type email
    python manage.py rebuild_rag_index --all --inline          # no Celery; index in this process
"""

from __future__ import annotations

import time
import uuid

from django.core.management.base import BaseCommand, CommandError

from apps.core.tenancy.context import system_context, tenant_context
from apps.rag import events, indexing, sources
from apps.rag.models import IndexEvent, IndexStatus


class Command(BaseCommand):
    help = "Queue every indexable CRM source for (re)indexing into the RAG knowledge index."

    def add_arguments(self, parser):
        parser.add_argument("--organization", help="Organization UUID. Omit with --all for every workspace.")
        parser.add_argument("--all", action="store_true", help="Process every active organization.")
        parser.add_argument(
            "--source-type",
            action="append",
            dest="source_types",
            choices=sorted(sources.SOURCES),
            help="Limit to one or more source types (repeatable).",
        )
        parser.add_argument("--batch", type=int, default=500, help="Sources queued between pauses.")
        parser.add_argument("--pause", type=float, default=0.5, help="Seconds to wait between batches.")
        parser.add_argument(
            "--inline",
            action="store_true",
            help="Index in this process instead of queueing (useful without a worker).",
        )
        parser.add_argument("--stale-only", action="store_true", help="Only sources not yet indexed or failed.")

    def handle(self, *args, **options):
        organization_ids = self._organizations(options)
        if not organization_ids:
            raise CommandError("Give --organization <uuid> or --all.")
        selected = options.get("source_types") or list(sources.source_types())
        total = 0
        for organization_id in organization_ids:
            total += self._one(organization_id, selected, options)
        verb = "indexed" if options["inline"] else "queued"
        self.stdout.write(
            self.style.SUCCESS(f"{total} source(s) {verb} across {len(organization_ids)} organization(s).")
        )

    def _organizations(self, options) -> list[uuid.UUID]:
        if options.get("organization"):
            try:
                return [uuid.UUID(options["organization"])]
            except ValueError as exc:
                raise CommandError("--organization must be a UUID.") from exc
        if not options.get("all"):
            return []
        from apps.accounts.models import Organization

        with system_context("rag.rebuild_index.list_organizations"):
            return list(Organization.objects.filter(status=Organization.Status.ACTIVE).values_list("pk", flat=True))

    def _one(self, organization_id: uuid.UUID, source_types: list[str], options) -> int:
        batch, pause, inline = options["batch"], options["pause"], options["inline"]
        queued = 0
        with tenant_context(organization_id, reason="rag.rebuild_index"):
            skip = self._already_indexed(organization_id) if options["stale_only"] else set()
            for source_type in source_types:
                spec = sources.spec_for(source_type)
                ids = spec.model.objects.filter(organization_id=organization_id).values_list("pk", flat=True)
                for source_id in ids.iterator(chunk_size=500):
                    if (source_type, source_id) in skip:
                        continue
                    if inline:
                        indexing.index_source(
                            organization_id=organization_id, source_type=source_type, source_id=source_id
                        )
                    else:
                        events.enqueue(organization_id=organization_id, source_type=source_type, source_id=source_id)
                    queued += 1
                    if batch > 0 and queued % batch == 0:
                        self.stdout.write(f"  {organization_id}: {queued} {source_type} sources so far…")
                        if pause > 0:
                            time.sleep(pause)
        return queued

    @staticmethod
    def _already_indexed(organization_id: uuid.UUID) -> set[tuple[str, uuid.UUID]]:
        return set(
            IndexEvent.objects.filter(organization_id=organization_id, status=IndexStatus.INDEXED).values_list(
                "source_type", "source_id"
            )
        )
