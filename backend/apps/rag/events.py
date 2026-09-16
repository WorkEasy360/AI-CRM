"""The transactional outbox: how a CRM write becomes an indexing job without ever risking CRM data.

    CRM transaction (note saved, email received, deal edited)
        |  the outbox row is written here, in the same transaction
        v
    COMMIT
        |  only now is the Celery job scheduled (transaction.on_commit)
        v
    rag.index_source  ->  chunk, embed, replace by exact source identity

If the transaction rolls back, the outbox row disappears with it and nothing was indexed. If the
process dies between COMMIT and the enqueue, the row is still ``pending`` and the sweeper
(``rag.drain_pending``) picks it up. If embedding fails, the row goes back to ``pending`` with a
backoff and the CRM record is untouched -- indexing failure is never a CRM failure.

One row per source record, so the outbox doubles as the indexing state admins can see. ``revision``
is bumped on every write: a worker that started before a newer write refuses to mark the row
``indexed``, which is what keeps a change made mid-indexing from being silently dropped.
"""

from __future__ import annotations

import contextlib
import uuid
from typing import Any

import structlog
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from apps.rag.models import IndexEvent, IndexStatus, KnowledgeChunk

log = structlog.get_logger(__name__)


def enqueue(
    *,
    organization_id: uuid.UUID,
    source_type: str,
    source_id: uuid.UUID,
    operation: str = IndexEvent.Operation.UPSERT,
) -> None:
    """Record the intent to (re)index or drop one source, and schedule the job for after COMMIT."""
    if organization_id is None or source_id is None:
        return
    _upsert(organization_id=organization_id, source_type=source_type, source_id=source_id, operation=operation)
    transaction.on_commit(
        lambda: _schedule(organization_id=organization_id, source_type=source_type, source_id=source_id)
    )


def _upsert(*, organization_id: uuid.UUID, source_type: str, source_id: uuid.UUID, operation: str) -> None:
    now = timezone.now()
    fields: dict[str, Any] = {
        "operation": operation,
        "status": IndexStatus.PENDING,
        "revision": F("revision") + 1,
        "available_at": None,
        "attempts": 0,
        "last_error": "",
        "updated_at": now,
    }
    updated = IndexEvent.objects.filter(
        organization_id=organization_id, source_type=source_type, source_id=source_id
    ).update(**fields)
    if updated:
        return
    try:
        # savepoint: a lost race on the unique constraint must not poison the CRM transaction.
        with transaction.atomic():
            IndexEvent.objects.create(
                organization_id=organization_id,
                source_type=source_type,
                source_id=source_id,
                operation=operation,
                status=IndexStatus.PENDING,
            )
    except IntegrityError:
        IndexEvent.objects.filter(organization_id=organization_id, source_type=source_type, source_id=source_id).update(
            **fields
        )


def _schedule(*, organization_id: uuid.UUID, source_type: str, source_id: uuid.UUID) -> None:
    """Best effort: a broker outage leaves the row ``pending`` for the sweeper rather than raising."""
    from apps.rag import tasks

    try:
        tasks.index_source.delay(
            organization_id=str(organization_id), source_type=source_type, source_id=str(source_id)
        )
    except Exception as exc:  # pragma: no cover - broker down
        log.warning("rag.enqueue_failed", source_type=source_type, error=str(exc)[:200])


def refresh_entity_owner(*, organization_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID, owner_id) -> int:
    """Keep the denormalised owner used by the retrieval pre-filter in step with a reassignment.

    Only the pre-filter depends on this column; ``apps.rag.retrieval`` re-resolves every candidate
    record against live CRM state afterwards, so a missed refresh can only cost recall, never
    isolation.
    """
    return (
        KnowledgeChunk.objects.filter(organization_id=organization_id, entity_type=entity_type, entity_id=entity_id)
        .exclude(entity_owner_id=owner_id)
        .update(entity_owner_id=owner_id, updated_at=timezone.now())
    )


def purge_entity(*, organization_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID) -> int:
    """A CRM record was permanently deleted: drop every chunk that hung off it (privacy, retention).

    Scoped by exact identity -- organization, entity type and entity id. Never by text or topic.
    """
    deleted, _ = KnowledgeChunk.objects.filter(
        organization_id=organization_id, entity_type=entity_type, entity_id=entity_id
    ).delete()
    with contextlib.suppress(Exception):
        IndexEvent.objects.filter(organization_id=organization_id).filter(
            source_type="deal", source_id=entity_id
        ).delete()
    return deleted
