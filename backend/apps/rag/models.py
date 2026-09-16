"""The RAG knowledge index: chunked CRM text plus the outbox that keeps it in step with the CRM.

Two tables, both tenant-owned and both under forced Row Level Security:

``KnowledgeChunk``
    One retrievable piece of unstructured CRM text (a note, an email body, a WhatsApp message, a
    meeting or call write-up, a deal description). A chunk is addressed by its *exact source
    identity* -- ``(organization, source_type, source_id, chunk_index)`` -- so an update or a delete
    replaces precisely the rows belonging to that record and nothing else. Chunks are never matched
    or removed by topic, name or text.

    Authorization is carried on the row, not applied afterwards. ``entity_*`` records the CRM record
    the chunk hangs off and its owner; ``source_owner`` records the owner of the source row itself.
    Retrieval turns the actor's own/team/all scopes into SQL predicates over those columns, so a
    chunk outside the caller's scope is never read, ranked or scored (see ``apps.rag.retrieval``).

``IndexEvent``
    One row per source record: both the transactional outbox entry and the durable indexing state
    the admin screen reads. Written inside the CRM transaction, drained by Celery after COMMIT.
"""

from __future__ import annotations

from typing import ClassVar

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models
from pgvector.django import HnswIndex, VectorField

from apps.core.models import TenantModel

# Every embedding column is this wide. Adapters that produce a different native width project or
# pad to it (apps.rag.embeddings), so one column serves every provider and the index stays valid.
EMBEDDING_DIM = 1024


class SourceType(models.TextChoices):
    NOTE = "note", "Note"
    EMAIL = "email", "Email"
    WHATSAPP = "whatsapp", "WhatsApp message"
    ACTIVITY = "activity", "Meeting or call"
    DEAL = "deal", "Deal description"


class IndexStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    PROCESSING = "processing", "Processing"
    INDEXED = "indexed", "Indexed"
    FAILED = "failed", "Failed"
    STALE = "stale", "Stale"


class KnowledgeChunk(TenantModel):
    """A chunk of unstructured CRM text, embedded and full-text indexed for retrieval."""

    # Ownership is expressed through two explicit columns (below) rather than a single OWNER_FIELD,
    # because a chunk is gated by *both* its source row and its parent CRM record.
    OWNER_FIELD: ClassVar[str | None] = None

    source_type = models.CharField(max_length=16, choices=SourceType.choices)
    source_id = models.UUIDField()
    chunk_index = models.PositiveSmallIntegerField(default=0)

    # The CRM record this text belongs to, and that record's owner. Retrieval filters on these with
    # the actor's own/team/all scope for the record's view permission.
    entity_type = models.CharField(max_length=16, blank=True)
    entity_id = models.UUIDField(null=True, blank=True)
    entity_owner = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    # The owner of the source row itself (note author, activity owner, message sender).
    source_owner = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    content = models.TextField()
    # sha256 of the *whole source's* canonical text. Unchanged hash => nothing is re-embedded.
    content_hash = models.CharField(max_length=64)
    # Optimistic-concurrency version of the source record where it has one (deals), else 0.
    source_version = models.PositiveIntegerField(default=0)
    # When the underlying event happened, used for recency ranking and for citation labels.
    occurred_at = models.DateTimeField(null=True, blank=True)

    embedding = VectorField(dimensions=EMBEDDING_DIM, null=True, blank=True)
    embedding_model = models.CharField(max_length=64, blank=True)
    embedding_version = models.PositiveSmallIntegerField(default=1)
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "source_type", "source_id", "chunk_index"], name="uniq_rag_chunk_identity"
            )
        ]
        indexes = [
            # Exact-identity replace and delete (the only way chunks are ever removed).
            models.Index(fields=["organization", "source_type", "source_id"], name="ragchunk_org_source_idx"),
            # Retrieval pre-filter: organization, then the parent record.
            models.Index(fields=["organization", "entity_type", "entity_id"], name="ragchunk_org_entity_idx"),
            models.Index(fields=["organization", "entity_owner"], name="ragchunk_org_entowner_idx"),
            GinIndex(fields=["search_vector"], name="ragchunk_search_idx"),
            HnswIndex(
                name="ragchunk_embedding_idx",
                fields=["embedding"],
                m=16,
                ef_construction=64,
                opclasses=["vector_cosine_ops"],
            ),
        ]

    def __str__(self) -> str:
        return f"{self.source_type}:{self.source_id}#{self.chunk_index}"


class IndexEvent(TenantModel):
    """Transactional outbox and indexing state for one source record.

    One row per ``(organization, source_type, source_id)``. A CRM write bumps ``revision`` and sets
    the row back to ``pending`` *inside the same transaction*; the Celery job is scheduled only on
    COMMIT. The worker captures ``revision`` when it starts and refuses to mark the row ``indexed``
    if it changed meanwhile, so a write that lands mid-indexing is never lost.
    """

    OWNER_FIELD: ClassVar[str | None] = None

    class Operation(models.TextChoices):
        UPSERT = "upsert", "Index or re-index"
        DELETE = "delete", "Remove from the index"

    source_type = models.CharField(max_length=16, choices=SourceType.choices)
    source_id = models.UUIDField()
    operation = models.CharField(max_length=8, choices=Operation.choices, default=Operation.UPSERT)
    status = models.CharField(max_length=12, choices=IndexStatus.choices, default=IndexStatus.PENDING)
    revision = models.PositiveBigIntegerField(default=1)
    attempts = models.PositiveSmallIntegerField(default=0)
    last_error = models.CharField(max_length=255, blank=True)
    # Backoff gate: the sweeper only picks up rows whose time has come.
    available_at = models.DateTimeField(null=True, blank=True)
    indexed_at = models.DateTimeField(null=True, blank=True)
    chunk_count = models.PositiveSmallIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "source_type", "source_id"], name="uniq_rag_index_event_source"
            )
        ]
        indexes = [
            models.Index(fields=["organization", "status", "available_at"], name="ragevent_org_status_idx"),
            models.Index(fields=["status", "available_at"], name="ragevent_status_avail_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.source_type}:{self.source_id} {self.status}"
