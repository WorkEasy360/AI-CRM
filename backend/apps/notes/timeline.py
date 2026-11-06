"""Record timeline: one merged, newest-first, paged feed of everything that happened to a record.

A pluggable source registry, not a union query. Each source (notes, activities, emails, WhatsApp, stage
history, field changes, files, ...) registers a provider for the entity types it knows about; a later
channel (payments and form submissions in M6, telephony in M4) registers one more source and the feed,
the API and the UI pick it up with no redesign.

Contract for a provider ``fn(actor, entity_type, record, window)``:
- ``record`` is already authorised for viewing; the provider must still return only rows the actor may
  see (its own permission, owner scope and field rules);
- it returns at most ``window.limit`` events, newest first, all with ``occurred_at < window.before``
  when ``before`` is set, and it filters and orders on the same timestamp it reports as ``occurred_at``.
Paging is by time: the response carries ``next_before`` (the oldest ``occurred_at`` returned).
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from django.db.models import Q

from apps.authz.actor import Actor
from apps.authz.service import scope

TimelineEvent = dict[str, Any]


@dataclass(frozen=True)
class Window:
    before: dt.datetime | None = None
    limit: int = 50

    def apply(self, qs: Any, column: str) -> Any:
        if self.before is not None:
            qs = qs.filter(**{f"{column}__lt": self.before})
        return qs.order_by(f"-{column}")[: self.limit]


Provider = Callable[[Actor, str, Any, Window], list[TimelineEvent]]


@dataclass(frozen=True)
class Source:
    key: str
    label: str
    entity_types: tuple[str, ...]


_PROVIDERS: dict[str, list[tuple[str, Provider]]] = {}
_SOURCES: dict[str, Source] = {}
MAX_EVENTS = 200
DEFAULT_PAGE = 50


def register(entity_types: tuple[str, ...], *, source: str, label: str = "") -> Callable[[Provider], Provider]:
    def decorator(fn: Provider) -> Provider:
        for et in entity_types:
            bucket = _PROVIDERS.setdefault(et, [])
            if (source, fn) not in bucket:
                bucket.append((source, fn))
        known = _SOURCES.get(source)
        merged = tuple(dict.fromkeys((*(known.entity_types if known else ()), *entity_types)))
        _SOURCES[source] = Source(source, label or (known.label if known else source.replace("_", " ")), merged)
        return fn

    return decorator


def sources(entity_type: str) -> list[Source]:
    keys = dict.fromkeys(s for s, _ in _PROVIDERS.get(entity_type, []))
    return [_SOURCES[k] for k in keys]


def build_page(
    actor: Actor,
    entity_type: str,
    record: Any,
    *,
    kinds: set[str] | None = None,
    only_sources: set[str] | None = None,
    before: dt.datetime | None = None,
    limit: int = DEFAULT_PAGE,
) -> tuple[list[TimelineEvent], dt.datetime | None]:
    """One page of the merged feed and the cursor for the next (None when there is nothing older)."""
    limit = max(1, min(limit, MAX_EVENTS))
    window = Window(before=before, limit=limit + 1)
    events: list[TimelineEvent] = []
    for source, provider in _PROVIDERS.get(entity_type, []):
        if only_sources and source not in only_sources:
            continue
        for event in provider(actor, entity_type, record, window):
            event.setdefault("source", source)
            events.append(event)
    if kinds:
        events = [e for e in events if e["kind"] in kinds or e["kind"].split(".", 1)[0] in kinds]
    events.sort(key=lambda e: e["occurred_at"], reverse=True)
    page = events[:limit]
    more = len(events) > limit
    return page, (page[-1]["occurred_at"] if more and page else None)


def build(
    actor: Actor, entity_type: str, record: Any, *, kinds: set[str] | None = None, limit: int = MAX_EVENTS
) -> list[TimelineEvent]:
    """The newest ``limit`` events (no paging)."""
    return build_page(actor, entity_type, record, kinds=kinds, limit=limit)[0]


def member_ref(m: Any) -> dict[str, Any] | None:
    if m is None:
        return None
    return {"id": str(m.pk), "display_name": m.user.display_name}


_member = member_ref


@register(("contact", "company", "deal", "product"), source="record", label="Record")
def _created(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    if window.before is not None and record.created_at >= window.before:
        return []
    created_by = getattr(record, "created_by", None)
    return [
        {
            "id": f"created:{record.pk}",
            "kind": "record.created",
            "occurred_at": record.created_at,
            "actor": _member(created_by),
            "data": {},
        }
    ]


@register(("contact", "company", "deal", "product", "activity"), source="notes", label="Notes")
def _notes(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    from apps.notes.models import Note

    qs = window.apply(
        Note.objects.filter(entity_type=entity_type, entity_id=record.pk).select_related("author__user"), "created_at"
    )
    return [
        {
            "id": f"note:{n.pk}",
            "kind": "note",
            "occurred_at": n.created_at,
            "actor": _member(n.author),
            "data": {"note_id": str(n.pk), "body": n.body, "pinned": n.pinned, "edited_at": n.edited_at},
        }
        for n in qs
    ]


@register(("contact", "company", "deal", "product", "activity"), source="files", label="Files")
def _files(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    from apps.files.models import FileAttachment

    if not actor.has("files.view"):
        return []
    qs = window.apply(
        FileAttachment.objects.filter(entity_type=entity_type, entity_id=record.pk).select_related("uploaded_by__user"),
        "created_at",
    )
    return [
        {
            "id": f"file:{f.pk}",
            "kind": "file",
            "occurred_at": f.created_at,
            "actor": _member(f.uploaded_by),
            "data": {
                "file_id": str(f.pk),
                "filename": f.filename,
                "content_type": f.content_type,
                "size_bytes": f.size_bytes,
            },
        }
        for f in qs
    ]


@register(("deal",), source="stage_history", label="Stage changes")
def _deal_stage_history(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    from apps.deals.models import DealStageHistory

    qs = window.apply(
        DealStageHistory.objects.filter(deal=record).select_related("from_stage", "to_stage", "changed_by__user"),
        "changed_at",
    )
    return [
        {
            "id": f"stage:{h.pk}",
            "kind": "deal.stage_changed",
            "occurred_at": h.changed_at,
            "actor": _member(h.changed_by),
            "data": {
                "from_stage": {"id": str(h.from_stage.pk), "name": h.from_stage.name} if h.from_stage else None,
                "to_stage": {"id": str(h.to_stage.pk), "name": h.to_stage.name, "kind": h.to_stage.kind},
                "source": h.source,
            },
        }
        for h in qs
    ]


@register(("contact", "company"), source="deals", label="Deals")
def _related_deals(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    """Deals the actor may see that reference this contact/company (creation events only)."""
    from apps.authz import fields as field_rules
    from apps.deals.models import Deal

    cond = (
        Q(company=record) if entity_type == "company" else Q(primary_contact=record) | Q(deal_contacts__contact=record)
    )
    qs = window.apply(
        scope(actor, "deals.view", Deal.objects.filter(cond, archived_at__isnull=True))
        .select_related("stage", "created_by__user")
        .distinct(),
        "created_at",
    )
    return [
        {
            "id": f"deal:{d.pk}",
            "kind": "deal.linked",
            "occurred_at": d.created_at,
            "actor": _member(d.created_by),
            # A related deal's amount follows the deal's field rules.
            "data": field_rules.mask(
                actor,
                "deal",
                {
                    "deal_id": str(d.pk),
                    "name": d.name,
                    "status": d.status,
                    "stage": d.stage.name,
                    "amount": str(d.amount),
                    "currency": d.currency,
                },
            ),
        }
        for d in qs
    ]
