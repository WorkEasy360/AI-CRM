"""Keep the help tables in step with the articles: the repository's (global) and a workspace's own.

Global articles live in ``docs/help-kb/articles`` and are bundled into ``apps/helpkb/kb/articles.json``
by ``scripts/help_kb.py build`` (the backend image is built from ``backend/`` only, so it cannot read
``docs/``). ``sync_global`` runs after every ``migrate`` and is idempotent: an unchanged article
(same content hash) is not touched and not re-embedded; an article removed from the repository is
removed here.

Every save re-chunks and re-embeds the article it touched, so retrieval never serves a stale section.
Embedding is best effort: without an embedding provider the chunks are stored without vectors and the
lexical half of retrieval still answers.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import structlog
from django.conf import settings
from django.core.cache import cache
from django.db import transaction

from apps.helpkb import parser
from apps.helpkb.models import HelpArticle, HelpChunk, OrgHelpArticle, OrgHelpChunk

log = structlog.get_logger(__name__)

BUNDLE = Path(__file__).resolve().parent / "kb" / "articles.json"
GLOBAL_STAMP_KEY = "helpkb:global-stamp"
ARTICLE_FIELDS = (
    "title",
    "question",
    "module",
    "keywords",
    "route",
    "menu_path",
    "spotlight",
    "permission",
    "related",
    "body",
    "status",
    "updated",
)


def content_hash(data: dict[str, Any]) -> str:
    canonical = json.dumps({key: data.get(key) for key in ("id", *ARTICLE_FIELDS)}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_bundle(path: Path | None = None) -> list[dict[str, Any]]:
    path = path or Path(getattr(settings, "HELP_KB_BUNDLE", "") or BUNDLE)
    if not path.exists():
        log.warning("helpkb.bundle_missing", path=str(path))
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return list(data.get("articles", []))


def chunks_for(article: parser.Article) -> list[tuple[str, str]]:
    """One chunk per section, each prefixed with the title so a section is retrievable on its own."""
    head = f"{article.title}\n{article.question}\n{', '.join(article.keywords)}"
    out = [("Title", f"{head}\n{article.menu_path}".strip())]
    for name, text in article.sections.items():
        if text.strip():
            out.append((name[:40], f"{article.title} -- {name}\n{text.strip()}"))
    return out


def _embed(texts: list[str]) -> tuple[list[list[float] | None], str]:
    from apps.rag.embeddings import EmbeddingError, current_model, get_embedder

    try:
        vectors = get_embedder().embed(texts)
    except EmbeddingError as exc:
        log.warning("helpkb.embedding_unavailable", reason=exc.message[:120])
        return [None] * len(texts), ""
    return list(vectors), current_model()


def _write_chunks(model: Any, article_obj: Any, article: parser.Article) -> int:
    pieces = chunks_for(article)
    vectors, embedding_model = _embed([content for _, content in pieces])
    model.objects.filter(article=article_obj).delete()
    model.objects.bulk_create(
        [
            model(
                article=article_obj,
                position=position,
                section=section,
                content=content,
                embedding=vector,
                embedding_model=embedding_model if vector is not None else "",
                **({"organization_id": article_obj.organization_id} if model is OrgHelpChunk else {}),
            )
            for position, ((section, content), vector) in enumerate(zip(pieces, vectors, strict=True))
        ]
    )
    return len(pieces)


def to_article(row: Any) -> parser.Article:
    return parser.Article(
        id=row.slug,
        title=row.title,
        question=row.question,
        module=row.module,
        route=row.route,
        body=row.body,
        keywords=list(row.keywords or []),
        related=list(row.related or []),
        menu_path=row.menu_path,
        spotlight=row.spotlight,
        permission=row.permission,
        updated=row.updated,
        status=row.status,
    )


def sync_global(articles: list[dict[str, Any]] | None = None, *, reembed: bool = False) -> dict[str, int]:
    """Upsert the bundled articles into the global tables. Returns counts of what changed."""
    articles = load_bundle() if articles is None else articles
    stats = {"created": 0, "updated": 0, "deleted": 0, "unchanged": 0, "invalid": 0}
    seen: set[str] = set()
    existing = {row.slug: row for row in HelpArticle.objects.all()}
    for data in articles:
        article = parser.from_dict(data)
        problems = parser.validate(article)
        if problems:
            stats["invalid"] += 1
            log.warning("helpkb.invalid_article", slug=data.get("id"), problems=problems[:3])
            continue
        seen.add(article.id)
        digest = content_hash(article.as_dict())
        row = existing.get(article.id)
        with transaction.atomic():
            if row is None:
                row = HelpArticle.objects.create(slug=article.id, content_hash=digest, **_fields(article))
                stats["created"] += 1
            elif row.content_hash != digest:
                for key, value in _fields(article).items():
                    setattr(row, key, value)
                row.content_hash = digest
                row.save()
                stats["updated"] += 1
            elif not reembed and row.chunks.exists():
                stats["unchanged"] += 1
                continue
            else:
                stats["unchanged"] += 1
            _write_chunks(HelpChunk, row, article)
    stale = [slug for slug in existing if slug not in seen]
    if stale and articles:
        stats["deleted"] = HelpArticle.objects.filter(slug__in=stale).delete()[0]
    if stats["created"] or stats["updated"] or stats["deleted"] or reembed:
        bump_global_stamp()
    return stats


def _fields(article: parser.Article) -> dict[str, Any]:
    return {
        "title": article.title,
        "question": article.question,
        "module": article.module,
        "keywords": list(article.keywords),
        "route": article.route,
        "menu_path": article.menu_path,
        "spotlight": article.spotlight,
        "permission": article.permission,
        "related": list(article.related),
        "body": article.body,
        "status": article.status,
        "updated": article.updated,
    }


def bump_global_stamp() -> None:
    import time

    cache.set(GLOBAL_STAMP_KEY, str(time.time_ns()), None)


def global_stamp() -> str:
    stamp = cache.get(GLOBAL_STAMP_KEY)
    if stamp is None:
        bump_global_stamp()
        stamp = cache.get(GLOBAL_STAMP_KEY) or "0"
    return str(stamp)


def reindex_org_article(row: OrgHelpArticle) -> int:
    """Re-chunk and re-embed one workspace article. Runs inside the caller's tenant context."""
    return _write_chunks(OrgHelpChunk, row, to_article(row))


def apply_fields(row: Any, article: parser.Article) -> None:
    for key, value in _fields(article).items():
        setattr(row, key, value)
    row.content_hash = content_hash(article.as_dict())
