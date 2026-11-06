"""Hybrid retrieval over the help knowledge base.

    question (+ the page the user is on)
      -> lexical BM25 over the whole article set   (exact UI words, Hinglish, Hindi)
      -> pgvector cosine over article sections     (paraphrase, when a semantic model is configured)
      -> weighted Reciprocal Rank Fusion           (no score calibration between the two)
      -> confidence gate                           (below it the question is "unanswered", never guessed)

The corpus a member searches is the global product guide overlaid with their own workspace's
published articles; an org article with a global article's slug replaces it for that workspace only.
Org rows are read through the tenant manager (and RLS), so another workspace's articles can never
enter the corpus. Help articles describe the software, not customer data, so a member sees articles
for features their role cannot use -- the answer says so instead of pretending the feature is absent.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import structlog
from django.db import DatabaseError, transaction
from django.db.models import Count, Max
from pgvector.django import CosineDistance

from apps.authz.actor import Actor
from apps.helpkb import parser, ranking, sync
from apps.helpkb.models import ArticleStatus, HelpArticle, HelpChunk, OrgHelpArticle, OrgHelpChunk

log = structlog.get_logger(__name__)

MAX_QUERY_CHARS = 400
VECTOR_CANDIDATES = 40
RRF_K = 20
LEXICAL_WEIGHT = 1.0
VECTOR_WEIGHT = 0.5
# A match is trusted when most of the question's topic words appear in the article (the same gate the
# eval in scripts/help_kb.py measures), or when a semantic embedding model puts one of its sections very
# close to the question.
MAX_SEMANTIC_DISTANCE = 0.32
# The local hash "embedding" is lexical in disguise; its similarity is not evidence of meaning.
NON_SEMANTIC_MODELS = frozenset({"keel-local-hash-v1"})


@dataclass
class Entry:
    article: parser.Article
    source: str  # "global" | "org"


@dataclass
class Match:
    article: parser.Article
    source: str
    score: float
    coverage: float = 0.0
    lexical_score: float = 0.0
    distance: float | None = None

    @property
    def slug(self) -> str:
        return self.article.id


@dataclass
class Result:
    matches: list[Match] = field(default_factory=list)
    confident: bool = False
    semantic: bool = False

    @property
    def best(self) -> Match | None:
        return self.matches[0] if self.matches else None


# --------------------------------------------------------------------------- corpus


class _Cache:
    """Per-process LRU of built indexes, keyed by everything that can change them."""

    def __init__(self, size: int = 64):
        self.size = size
        self.data: OrderedDict[tuple, tuple[dict[str, Entry], ranking.Index]] = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key: tuple):
        with self.lock:
            value = self.data.get(key)
            if value is not None:
                self.data.move_to_end(key)
            return value

    def put(self, key: tuple, value) -> None:
        with self.lock:
            self.data[key] = value
            self.data.move_to_end(key)
            while len(self.data) > self.size:
                self.data.popitem(last=False)


_INDEXES = _Cache()


def _global_entries() -> dict[str, Entry]:
    rows = HelpArticle.objects.filter(status=ArticleStatus.PUBLISHED)
    return {row.slug: Entry(sync.to_article(row), "global") for row in rows}


def _org_state() -> tuple:
    agg = OrgHelpArticle.objects.aggregate(latest=Max("updated_at"), count=Count("id"))
    return (agg["latest"].isoformat() if agg["latest"] else "", agg["count"])


def corpus(actor: Actor) -> tuple[dict[str, Entry], ranking.Index]:
    """The articles this member's workspace answers from, and the BM25 index over them."""
    key = (sync.global_stamp(), str(actor.organization.pk), *_org_state())
    cached = _INDEXES.get(key)
    if cached is not None:
        return cached
    entries = _global_entries()
    # Tenant manager + RLS: only this workspace's rows. A draft override leaves the global article in place.
    for row in OrgHelpArticle.objects.filter(status=ArticleStatus.PUBLISHED):
        entries[row.slug] = Entry(sync.to_article(row), "org")
    index = ranking.Index(
        ranking.Doc(
            id=slug,
            title=entry.article.title,
            question=entry.article.question,
            keywords=entry.article.keywords,
            menu_path=entry.article.menu_path,
            spotlight=entry.article.spotlight,
            body=entry.article.body,
            route_path=entry.article.path_only,
            module=entry.article.module,
        )
        for slug, entry in entries.items()
    )
    _INDEXES.put(key, (entries, index))
    return entries, index


def get(actor: Actor, slug: str) -> Entry | None:
    entries, _ = corpus(actor)
    return entries.get(slug)


# --------------------------------------------------------------------------- retrieval


def search(actor: Actor, question: str, *, page: str = "", limit: int = 3) -> Result:
    question = (question or "").replace("\x00", "").strip()[:MAX_QUERY_CHARS]
    if not question:
        return Result()
    entries, index = corpus(actor)
    lexical = index.search(question, page=page, limit=VECTOR_CANDIDATES)
    vector, semantic = _vector(actor, question, entries)

    fused: dict[str, Match] = {}
    for position, hit in enumerate(lexical):
        entry = entries[hit.id]
        match = fused.setdefault(hit.id, Match(entry.article, entry.source, 0.0))
        match.score += LEXICAL_WEIGHT / (RRF_K + position + 1)
        match.coverage, match.lexical_score = hit.coverage, hit.score
    # The vector half votes only when the model knows meaning; the local hash model would just echo BM25 noisily.
    for position, (slug, distance) in enumerate(vector if semantic else []):
        found = entries.get(slug)
        if found is None:
            continue
        match = fused.setdefault(slug, Match(found.article, found.source, 0.0))
        match.score += VECTOR_WEIGHT / (RRF_K + position + 1)
        match.distance = distance
    ordered = sorted(fused.values(), key=lambda m: (-m.score, -m.lexical_score))[: max(1, limit)]
    return Result(matches=ordered, confident=bool(ordered) and is_confident(ordered[0], semantic), semantic=semantic)


def is_confident(match: Match, semantic: bool) -> bool:
    if ranking.is_confident(ranking.Hit(id=match.slug, score=match.lexical_score, coverage=match.coverage)):
        return True
    return semantic and match.distance is not None and match.distance <= MAX_SEMANTIC_DISTANCE


def _vector(actor: Actor, question: str, entries: dict[str, Entry]) -> tuple[list[tuple[str, float]], bool]:
    """Nearest article sections, best distance per article. ``([], False)`` when embeddings are unavailable."""
    from apps.rag.embeddings import EmbeddingError, current_model, get_embedder

    model = current_model()
    try:
        vector = get_embedder().embed([question])[0]
    except EmbeddingError as exc:
        log.info("helpkb.embedding_unavailable", reason=exc.message[:120])
        return [], False
    best: dict[str, float] = {}
    try:
        with transaction.atomic():  # savepoint: a failed vector query must not poison the request transaction
            for queryset, slug_field in (
                (HelpChunk.objects.filter(article__status=ArticleStatus.PUBLISHED), "article__slug"),
                (OrgHelpChunk.objects.filter(article__status=ArticleStatus.PUBLISHED), "article__slug"),
            ):
                rows = (
                    queryset.filter(embedding__isnull=False, embedding_model=model)
                    .annotate(distance=CosineDistance("embedding", vector))
                    .order_by("distance")
                    .values_list(slug_field, "distance")[:VECTOR_CANDIDATES]
                )
                for slug, distance in rows:
                    # An org override shadows the global article: only the version in the corpus counts.
                    entry = entries.get(slug)
                    if entry is None:
                        continue
                    if (queryset.model is HelpChunk) != (entry.source == "global"):
                        continue
                    best[slug] = min(best.get(slug, 2.0), float(distance))
    except DatabaseError as exc:  # pragma: no cover - pgvector unavailable
        log.warning("helpkb.vector_failed", error=str(exc)[:200])
        return [], False
    ranked = sorted(best.items(), key=lambda item: item[1])
    return ranked, model not in NON_SEMANTIC_MODELS


def suggestions_for_page(actor: Actor, page: str, *, limit: int = 3) -> list[dict[str, str]]:
    """Questions for the chips above the help input: the articles about the page the user is on."""
    entries, _ = corpus(actor)
    path = parser.route_path(page or "")
    exact = [e for e in entries.values() if e.article.path_only == path]
    if not exact and path.count("/") > 1:
        parent = path.rsplit("/", 1)[0]
        exact = [e for e in entries.values() if e.article.path_only == parent]
    # Prefer articles the member can act on, then the guide's own order (module, title).
    exact.sort(key=lambda e: (not _allowed(actor, e.article), e.article.title))
    return [{"id": e.article.id, "question": e.article.question} for e in exact[:limit]]


def _allowed(actor: Actor, article: parser.Article) -> bool:
    if not article.permission:
        return True
    try:
        return actor.has(article.permission)
    except ValueError:
        return False


def permission_ok(actor: Actor, article: parser.Article) -> bool:
    return _allowed(actor, article)
