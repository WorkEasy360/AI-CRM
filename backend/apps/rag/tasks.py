"""RAG background jobs. All on the ``rag_indexing`` queue so embedding work never starves
notifications, imports or exports (docs/architecture/scaling.md, "Celery").
"""

from __future__ import annotations

import datetime as dt
import uuid

import structlog
from celery import shared_task
from django.db.models import Q
from django.utils import timezone

from apps.core.tenancy.context import system_context, tenant_context
from apps.core.tenancy.tasks import tenant_task
from apps.observability import metrics
from apps.rag import indexing
from apps.rag.models import IndexEvent, IndexStatus

log = structlog.get_logger(__name__)

SWEEP_BATCH = 200
# A row stuck in `processing` means the worker died mid-job; reclaim it after this long.
STUCK_AFTER_SECONDS = 900


@tenant_task(name="rag.index_source", ignore_result=True, soft_time_limit=120, time_limit=180)
def index_source(*, organization_id, source_type: str, source_id: str, **kwargs) -> str:
    result = indexing.index_source(
        organization_id=organization_id, source_type=source_type, source_id=uuid.UUID(str(source_id))
    )
    return result.status


@tenant_task(name="rag.rebuild_organization", ignore_result=True, soft_time_limit=1800, time_limit=2100)
def rebuild_organization(*, organization_id, source_types: list[str] | None = None, **kwargs) -> int:
    """Enqueue every indexable source of one organization. Resume-safe: unchanged content is skipped
    by ``content_hash`` when the job runs, so re-running costs queries but no embeddings."""
    from apps.rag import events, sources

    queued = 0
    for source_type in source_types or list(sources.source_types()):
        spec = sources.spec_for(source_type)
        ids = spec.model.objects.filter(organization_id=organization_id).values_list("pk", flat=True)
        for source_id in ids.iterator(chunk_size=500):
            events.enqueue(organization_id=organization_id, source_type=source_type, source_id=source_id)
            queued += 1
    return queued


@shared_task(name="rag.drain_pending", ignore_result=True, soft_time_limit=540, time_limit=600)
def drain_pending() -> int:
    """Beat: the safety net behind ``transaction.on_commit``.

    Picks up rows whose enqueue was lost (broker outage, process killed between COMMIT and publish),
    rows waiting out a failure backoff, and rows left ``processing`` by a worker that died.
    """
    now = timezone.now()
    stuck_before = now - dt.timedelta(seconds=STUCK_AFTER_SECONDS)
    with system_context("rag.drain_pending"):
        rows = list(
            IndexEvent.all_objects.filter(
                Q(status=IndexStatus.PENDING, available_at__isnull=True)
                | Q(status=IndexStatus.PENDING, available_at__lte=now)
                | Q(status=IndexStatus.PROCESSING, updated_at__lt=stuck_before)
            )
            .order_by("updated_at")
            .values_list("organization_id", "source_type", "source_id")[:SWEEP_BATCH]
        )
        pending_total = IndexEvent.all_objects.filter(status=IndexStatus.PENDING).count()
    metrics.publish([{"name": "RagIndexQueueDepth", "value": pending_total, "unit": "Count"}])
    for organization_id, source_type, source_id in rows:
        index_source.delay(organization_id=str(organization_id), source_type=source_type, source_id=str(source_id))
    return len(rows)


@shared_task(name="rag.purge_organization", ignore_result=True, soft_time_limit=600, time_limit=900)
def purge_organization(*, organization_id: str) -> int:
    """Remove an organization's whole knowledge index (tenant deletion, privacy erasure)."""
    from apps.rag.models import KnowledgeChunk

    org_id = uuid.UUID(str(organization_id))
    with tenant_context(org_id, reason="rag.purge_organization"):
        chunks, _ = KnowledgeChunk.objects.all().delete()
        IndexEvent.objects.all().delete()
    return chunks
