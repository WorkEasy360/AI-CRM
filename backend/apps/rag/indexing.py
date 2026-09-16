"""Draining the outbox: chunk, embed and replace one source's chunks by exact identity.

Invariants this module exists to hold:

- **Replace by identity, never by topic.** Every write and delete is keyed on
  ``(organization, source_type, source_id)``. There is no code path that removes a vector because
  its text mentions a customer or resembles another chunk.
- **Never re-embed unchanged content.** ``content_hash`` covers the source's whole canonical text; an
  unchanged hash (with the same embedding model) finishes the job without a single embedding call.
- **Indexing failure is not CRM failure.** Nothing here writes to a CRM table. A failure leaves the
  outbox row pending with a backoff and retries independently.
- **Writes are last.** Embeddings are generated *before* the transaction that swaps the chunks, so a
  provider timeout cannot hold a write lock on the index.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any

import structlog
from django.contrib.postgres.search import SearchVector
from django.db import transaction
from django.utils import timezone

from apps.observability import metrics
from apps.rag import events, sources
from apps.rag.chunking import chunk_document
from apps.rag.embeddings import EmbeddingError, current_model, get_embedder
from apps.rag.models import IndexEvent, IndexStatus, KnowledgeChunk

log = structlog.get_logger(__name__)

MAX_ATTEMPTS = 5
BACKOFF_SECONDS = (30, 120, 600, 1800, 3600)
FTS_CONFIG = "english"


@dataclass(frozen=True)
class IndexResult:
    status: str
    chunks: int = 0
    embedded: int = 0
    reason: str = ""


def index_source(*, organization_id: uuid.UUID, source_type: str, source_id: uuid.UUID) -> IndexResult:
    """Bring one source's chunks in line with its current content. Idempotent and resumable."""
    event = IndexEvent.objects.filter(
        organization_id=organization_id, source_type=source_type, source_id=source_id
    ).first()
    if event is None:
        # No outbox row: either already drained, or a direct rebuild call. Index anyway, safely.
        event = IndexEvent.objects.create(organization_id=organization_id, source_type=source_type, source_id=source_id)
    revision = event.revision
    IndexEvent.objects.filter(pk=event.pk, revision=revision).update(
        status=IndexStatus.PROCESSING, updated_at=timezone.now()
    )

    try:
        result = _apply(event=event, organization_id=organization_id, source_type=source_type, source_id=source_id)
    except EmbeddingError as exc:
        _fail(event, reason=exc.message, retryable=exc.retryable)
        metrics.publish([{"name": "RagIndexFailure", "value": 1, "unit": "Count"}])
        return IndexResult(status=IndexStatus.FAILED, reason=exc.message)
    except Exception as exc:  # pragma: no cover - unexpected; still must not lose the row
        log.exception("rag.index_failed", source_type=source_type)
        _fail(event, reason=str(exc)[:200], retryable=True)
        metrics.publish([{"name": "RagIndexFailure", "value": 1, "unit": "Count"}])
        return IndexResult(status=IndexStatus.FAILED, reason=str(exc)[:200])

    _settle(event, revision=revision, result=result)
    return result


def _apply(*, event: IndexEvent, organization_id: uuid.UUID, source_type: str, source_id: uuid.UUID) -> IndexResult:
    if event.operation == IndexEvent.Operation.DELETE:
        return IndexResult(status="deleted", chunks=_delete_chunks(organization_id, source_type, source_id))

    spec = sources.spec_for(source_type)
    obj = spec.queryset().filter(pk=source_id).first()
    if obj is None:
        # The row vanished between the write and the job (hard delete, or a rolled-back import).
        return IndexResult(status="deleted", chunks=_delete_chunks(organization_id, source_type, source_id))

    document = spec.extract(obj)
    chunks = chunk_document(document)
    if not chunks:
        # The source lost its text (a note emptied, a call with no write-up): drop what was indexed.
        return IndexResult(status="empty", chunks=_delete_chunks(organization_id, source_type, source_id))

    model = current_model()
    content_hash = document.content_hash
    existing = list(
        KnowledgeChunk.objects.filter(
            organization_id=organization_id, source_type=source_type, source_id=source_id
        ).values("content_hash", "embedding_model")
    )
    if (
        existing
        and len(existing) == len(chunks)
        and all(row["content_hash"] == content_hash and row["embedding_model"] == model for row in existing)
    ):
        # Identical content, same embedding model: nothing to embed, nothing to write.
        _refresh_metadata(organization_id, source_type, source_id, document)
        return IndexResult(status="unchanged", chunks=len(existing))

    vectors = get_embedder().embed([chunk.content for chunk in chunks])
    _replace(
        organization_id=organization_id,
        document=document,
        chunks=chunks,
        vectors=vectors,
        model=model,
        content_hash=content_hash,
    )
    metrics.publish([{"name": "RagChunksIndexed", "value": len(chunks), "unit": "Count"}])
    return IndexResult(status=IndexStatus.INDEXED, chunks=len(chunks), embedded=len(chunks))


@transaction.atomic
def _replace(
    *,
    organization_id: uuid.UUID,
    document: sources.SourceDocument,
    chunks: list[Any],
    vectors: list[list[float]],
    model: str,
    content_hash: str,
) -> None:
    """Swap this source's chunks atomically. Readers see either the old set or the new set."""
    _delete_chunks(organization_id, document.source_type, document.source_id)
    rows = [
        KnowledgeChunk(
            organization_id=organization_id,
            source_type=document.source_type,
            source_id=document.source_id,
            chunk_index=chunk.index,
            entity_type=document.entity_type,
            entity_id=document.entity_id,
            entity_owner_id=document.entity_owner_id,
            source_owner_id=document.source_owner_id,
            content=chunk.content,
            content_hash=content_hash,
            source_version=document.source_version,
            occurred_at=document.occurred_at,
            embedding=vector,
            embedding_model=model,
        )
        for chunk, vector in zip(chunks, vectors, strict=False)
    ]
    KnowledgeChunk.objects.bulk_create(rows)
    KnowledgeChunk.objects.filter(
        organization_id=organization_id, source_type=document.source_type, source_id=document.source_id
    ).update(search_vector=SearchVector("content", config=FTS_CONFIG))


def _refresh_metadata(
    organization_id: uuid.UUID, source_type: str, source_id: uuid.UUID, document: sources.SourceDocument
) -> None:
    """Content is unchanged but the record it hangs off may have been re-linked or reassigned."""
    KnowledgeChunk.objects.filter(
        organization_id=organization_id, source_type=source_type, source_id=source_id
    ).exclude(
        entity_type=document.entity_type,
        entity_id=document.entity_id,
        entity_owner_id=document.entity_owner_id,
        source_owner_id=document.source_owner_id,
    ).update(
        entity_type=document.entity_type,
        entity_id=document.entity_id,
        entity_owner_id=document.entity_owner_id,
        source_owner_id=document.source_owner_id,
        updated_at=timezone.now(),
    )


def _delete_chunks(organization_id: uuid.UUID, source_type: str, source_id: uuid.UUID) -> int:
    deleted, _ = KnowledgeChunk.objects.filter(
        organization_id=organization_id, source_type=source_type, source_id=source_id
    ).delete()
    return deleted


def _settle(event: IndexEvent, *, revision: int, result: IndexResult) -> None:
    """Mark the outbox row done -- unless a newer write arrived while we were working."""
    now = timezone.now()
    if result.status == "deleted":
        IndexEvent.objects.filter(pk=event.pk, revision=revision).delete()
        return
    updated = IndexEvent.objects.filter(pk=event.pk, revision=revision).update(
        status=IndexStatus.INDEXED,
        indexed_at=now,
        chunk_count=result.chunks,
        attempts=0,
        last_error="",
        available_at=None,
        updated_at=now,
    )
    if not updated:
        # Someone wrote to the source mid-index: leave it pending and let the sweeper re-run it.
        IndexEvent.objects.filter(pk=event.pk).update(status=IndexStatus.PENDING, available_at=None, updated_at=now)


def _fail(event: IndexEvent, *, reason: str, retryable: bool) -> None:
    now = timezone.now()
    attempts = event.attempts + 1
    if not retryable or attempts >= MAX_ATTEMPTS:
        IndexEvent.objects.filter(pk=event.pk).update(
            status=IndexStatus.FAILED, attempts=attempts, last_error=reason[:255], available_at=None, updated_at=now
        )
        return
    delay = BACKOFF_SECONDS[min(attempts - 1, len(BACKOFF_SECONDS) - 1)]
    IndexEvent.objects.filter(pk=event.pk).update(
        status=IndexStatus.PENDING,
        attempts=attempts,
        last_error=reason[:255],
        available_at=now + dt.timedelta(seconds=delay),
        updated_at=now,
    )


def mark_stale(*, organization_id: uuid.UUID, model: str) -> int:
    """The embedding model changed: every chunk built by another model must be rebuilt.

    The old chunks stay readable (retrieval simply ignores a foreign embedding model) until their
    source is re-indexed, so switching providers degrades recall rather than breaking the assistant.
    """
    stale_sources = (
        KnowledgeChunk.objects.filter(organization_id=organization_id)
        .exclude(embedding_model=model)
        .values_list("source_type", "source_id")
        .distinct()
    )
    count = 0
    for source_type, source_id in stale_sources.iterator(chunk_size=500):
        events.enqueue(organization_id=organization_id, source_type=source_type, source_id=source_id)
        count += 1
    return count
