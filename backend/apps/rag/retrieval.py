"""Secure hybrid retrieval over the knowledge index.

The order of operations is the security property. Authorization is not a filter applied to results;
it is part of the query:

    authenticated actor
      -> tenant manager + RLS          (organization boundary, in SQL and in the database)
      -> RBAC scope predicate          (own / team / all, as SQL over entity_owner + source_owner)
      -> vector and full-text ranking  (only ever over rows the caller may already read)
      -> verification against live CRM (archived, deleted or reassigned records drop out)
      -> citations built from CRM rows, never from indexed text

Nothing is retrieved globally and filtered afterwards: a chunk outside the caller's scope is never
read, never ranked, and never contributes a similarity score. The verification pass is deliberate
redundancy -- the denormalised owner columns make the pre-filter fast, and re-resolving the handful
of surviving records against live CRM state makes a stale column impossible to exploit.

Ranking fuses two independent retrievers with Reciprocal Rank Fusion: cosine similarity over
pgvector (what the text *means*, as far as the configured embedding model can tell) and PostgreSQL
full text (what the text literally *says*). Either one alone misses obvious answers; RRF needs no
score calibration between them, which matters because the two scales are not comparable.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import structlog
from django.conf import settings
from django.contrib.postgres.search import SearchQuery, SearchRank
from django.db import DatabaseError
from django.db.models import F, Q, QuerySet
from django.utils import timezone
from pgvector.django import CosineDistance

from apps.authz.actor import Actor
from apps.authz.catalogue import SCOPE_ALL, SCOPE_OWN, SCOPE_TEAM
from apps.authz.service import scope
from apps.rag.embeddings import EmbeddingError, current_model, get_embedder
from apps.rag.indexing import FTS_CONFIG
from apps.rag.models import KnowledgeChunk
from apps.rag.sources import ENTITY_PERMISSIONS, SOURCE_LABELS, SOURCE_PERMISSIONS

log = structlog.get_logger(__name__)

MAX_QUERY_CHARS = 400
# Candidates per retriever before fusion. Wide enough that fusion has something to work with,
# narrow enough that the verification pass stays a couple of indexed lookups.
CANDIDATES = 40
RRF_K = 60
RECENCY_HALF_LIFE_DAYS = 120
_WS = re.compile(r"\s+")


@dataclass
class RetrievedChunk:
    chunk_id: uuid.UUID
    source_type: str
    source_id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID | None
    content: str
    occurred_at: dt.datetime | None
    score: float = 0.0
    # Filled by the verification pass from the live CRM row.
    entity_name: str = ""

    @property
    def label(self) -> str:
        return SOURCE_LABELS.get(self.source_type, "Record")


@dataclass
class RetrievalResult:
    chunks: list[RetrievedChunk] = field(default_factory=list)
    # False when the vector half could not run (no embedding provider, or pgvector unavailable).
    semantic: bool = True
    # False when nothing could be retrieved at all; the assistant then answers from structured CRM only.
    available: bool = True
    reason: str = ""

    def __bool__(self) -> bool:
        return bool(self.chunks)


def normalise_query(text: str) -> str:
    return _WS.sub(" ", (text or "").replace("\x00", "")).strip()[:MAX_QUERY_CHARS]


# --------------------------------------------------------------------------- authorization


def scope_predicate(actor: Actor) -> Q | None:
    """The caller's own/team/all scopes as a SQL predicate. ``None`` means "retrieve nothing".

    A chunk must clear *both* gates, exactly as the record timeline does today:
      - the caller may view the CRM record it hangs off, within their scope for that record type;
      - the caller may view that *kind* of text, within their scope for its permission.
    """
    entity_q, has_entity = Q(), False
    for entity_type, permission in ENTITY_PERMISSIONS.items():
        clause = _owner_clause(actor, permission, "entity_owner_id")
        if clause is None:
            continue
        entity_q |= Q(entity_type=entity_type) & clause
        has_entity = True

    source_q, has_source = Q(), False
    for source_type, permission in SOURCE_PERMISSIONS.items():
        clause = _owner_clause(actor, permission, "source_owner_id")
        if clause is None:
            continue
        source_q |= Q(source_type=source_type) & clause
        has_source = True

    if not (has_entity and has_source):
        return None
    return entity_q & source_q


def _owner_clause(actor: Actor, permission: str, column: str) -> Q | None:
    """``None`` when this permission grants nothing here; otherwise the owner test for its scope.

    Fail closed like ``authz.service.scope``: an unrecognised scope retrieves nothing rather than
    everything. Scopes are validated when roles are defined, so this is a belt-and-braces default,
    and it is the direction a mistake here has to fail in.
    """
    granted = actor.scope_for(permission)
    if granted == SCOPE_ALL:
        return Q()  # no owner restriction; the organization boundary still applies
    if granted == SCOPE_OWN:
        return Q(**{column: actor.membership.id})
    if granted == SCOPE_TEAM:
        return Q(**{f"{column}__in": list(actor.team_member_ids)})
    return None


def base_queryset(actor: Actor) -> QuerySet | None:
    predicate = scope_predicate(actor)
    if predicate is None:
        return None
    # `objects` is the tenant manager: organization filtering happens here and again in RLS.
    return KnowledgeChunk.objects.filter(predicate)


# --------------------------------------------------------------------------- retrieval


def search(
    actor: Actor,
    query: str,
    *,
    limit: int | None = None,
    entity_type: str = "",
    entity_id: uuid.UUID | None = None,
    source_types: list[str] | None = None,
) -> RetrievalResult:
    """Top chunks for ``query`` that ``actor`` is allowed to read, newest-relevant first."""
    query = normalise_query(query)
    limit = max(1, min(limit or settings.RAG_MAX_CHUNKS, settings.RAG_MAX_CHUNKS))
    if not query:
        return RetrievalResult(chunks=[], available=True)

    queryset = base_queryset(actor)
    if queryset is None:
        return RetrievalResult(chunks=[], available=False, reason="no_permission")
    if entity_type and entity_id is not None:
        queryset = queryset.filter(entity_type=entity_type, entity_id=entity_id)
    if source_types:
        queryset = queryset.filter(source_type__in=source_types)

    lexical = _lexical_candidates(queryset, query)
    semantic, semantic_ok, reason = _semantic_candidates(queryset, query)
    if not semantic_ok and not lexical:
        return RetrievalResult(chunks=[], semantic=False, available=bool(lexical), reason=reason)

    fused = _fuse([semantic, lexical])
    verified = _verify(actor, fused, limit=limit)
    return RetrievalResult(chunks=verified, semantic=semantic_ok, available=True, reason=reason)


def _fields(queryset: QuerySet) -> QuerySet:
    return queryset.values("id", "source_type", "source_id", "entity_type", "entity_id", "content", "occurred_at")


def _lexical_candidates(queryset: QuerySet, query: str) -> list[dict[str, Any]]:
    """PostgreSQL full text. The query text is a bound parameter, never interpolated into SQL."""
    tsquery = SearchQuery(query, search_type="websearch", config=FTS_CONFIG)
    try:
        rows = list(
            _fields(
                queryset.annotate(rank=SearchRank(F("search_vector"), tsquery))
                .filter(search_vector=tsquery)
                .order_by("-rank", "-occurred_at")
            )[:CANDIDATES]
        )
    except DatabaseError:  # pragma: no cover - malformed tsquery input
        log.warning("rag.lexical_failed")
        return []
    return rows


def _semantic_candidates(queryset: QuerySet, query: str) -> tuple[list[dict[str, Any]], bool, str]:
    """Cosine nearest neighbours from pgvector, restricted to the embedding model in use.

    Vectors from a different model live in a different space; comparing across them produces
    confident nonsense, so they are excluded rather than mixed in.
    """
    try:
        vector = get_embedder().embed([query])[0]
    except EmbeddingError as exc:
        log.warning("rag.embedding_unavailable", reason=exc.message[:120])
        return [], False, "embeddings_unavailable"
    try:
        rows = list(
            _fields(
                queryset.filter(embedding__isnull=False, embedding_model=current_model())
                .annotate(distance=CosineDistance("embedding", vector))
                .order_by("distance")
            )[:CANDIDATES]
        )
    except DatabaseError as exc:  # pragma: no cover - pgvector missing or index unusable
        log.warning("rag.vector_search_failed", error=str(exc)[:200])
        return [], False, "vector_unavailable"
    return rows, True, ""


def _fuse(rankings: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Reciprocal Rank Fusion plus a gentle recency preference.

    RRF scores by *position*, not by score, so cosine distance and ts_rank never have to be made
    comparable. The recency term is deliberately weak: "what did they say about pricing" should
    still find the right conversation from six months ago.
    """
    now = timezone.now()
    scored: dict[uuid.UUID, dict[str, Any]] = {}
    for ranking in rankings:
        for position, row in enumerate(ranking):
            entry = scored.setdefault(row["id"], {**row, "score": 0.0})
            entry["score"] += 1.0 / (RRF_K + position + 1)
    for entry in scored.values():
        entry["score"] += 0.25 * _recency(entry.get("occurred_at"), now)
    return sorted(scored.values(), key=lambda row: row["score"], reverse=True)


def _recency(occurred_at: dt.datetime | None, now: dt.datetime) -> float:
    if occurred_at is None:
        return 0.0
    age_days = max(0.0, (now - occurred_at).total_seconds() / 86400.0)
    return 0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS)


# --------------------------------------------------------------------------- verification


def _verify(actor: Actor, rows: list[dict[str, Any]], *, limit: int) -> list[RetrievedChunk]:
    """Re-resolve every candidate's CRM record against live state, in the caller's scope.

    This is what makes a stale denormalised owner harmless and archived or deleted records
    disappear from answers immediately. Only the top candidates are checked, so this costs at most
    one indexed query per entity type.
    """
    by_type: dict[str, set[uuid.UUID]] = {}
    for row in rows[: CANDIDATES * 2]:
        if row["entity_type"] and row["entity_id"]:
            by_type.setdefault(row["entity_type"], set()).add(row["entity_id"])

    allowed: dict[tuple[str, uuid.UUID], str] = {}
    for entity_type, ids in by_type.items():
        permission = ENTITY_PERMISSIONS.get(entity_type)
        model = _entity_model(entity_type)
        if permission is None or model is None:
            continue
        queryset = scope(actor, permission, model.objects.filter(pk__in=ids, archived_at__isnull=True))
        for pk, name in _names(entity_type, queryset):
            allowed[(entity_type, pk)] = name

    out: list[RetrievedChunk] = []
    for row in rows:
        key = (row["entity_type"], row["entity_id"])
        if key not in allowed:
            continue
        out.append(
            RetrievedChunk(
                chunk_id=row["id"],
                source_type=row["source_type"],
                source_id=row["source_id"],
                entity_type=row["entity_type"],
                entity_id=row["entity_id"],
                content=row["content"],
                occurred_at=row["occurred_at"],
                score=float(row.get("score", 0.0)),
                entity_name=allowed[key],
            )
        )
        if len(out) >= limit:
            break
    return out


def _entity_model(entity_type: str) -> Any:
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal
    from apps.products.models import Product

    return {"contact": Contact, "company": Company, "deal": Deal, "product": Product}.get(entity_type)


def _names(entity_type: str, queryset: QuerySet) -> list[tuple[uuid.UUID, str]]:
    if entity_type == "contact":
        return [
            (row["pk"], f"{row['first_name']} {row['last_name']}".strip() or row.get("email") or "Contact")
            for row in queryset.values("pk", "first_name", "last_name", "email")
        ]
    return [(row["pk"], row["name"]) for row in queryset.values("pk", "name")]
