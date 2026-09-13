"""Record timeline: a merged, newest-first feed of what happened to one record.

Providers are registered per entity type so later phases (activities, emails, AI summaries) plug in
without touching this module. Every provider receives the *already authorised* record and the actor,
and must itself only return rows the actor may see.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from django.db.models import Q

from apps.authz.actor import Actor
from apps.authz.service import scope

TimelineEvent = dict[str, Any]
Provider = Callable[[Actor, str, Any], list[TimelineEvent]]

_PROVIDERS: dict[str, list[Provider]] = {}
MAX_EVENTS = 200


def register(entity_types: tuple[str, ...]) -> Callable[[Provider], Provider]:
    def decorator(fn: Provider) -> Provider:
        for et in entity_types:
            _PROVIDERS.setdefault(et, []).append(fn)
        return fn

    return decorator


def build(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
    events: list[TimelineEvent] = []
    for provider in _PROVIDERS.get(entity_type, []):
        events.extend(provider(actor, entity_type, record))
    events.sort(key=lambda e: e["occurred_at"], reverse=True)
    return events[:MAX_EVENTS]


def _member(m: Any) -> dict[str, Any] | None:
    if m is None:
        return None
    return {"id": str(m.pk), "display_name": m.user.display_name}


@register(("contact", "company", "deal", "product"))
def _created(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
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


@register(("contact", "company", "deal", "product"))
def _notes(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
    from apps.notes.models import Note

    qs = (
        Note.objects.filter(entity_type=entity_type, entity_id=record.pk)
        .select_related("author__user")
        .order_by("-created_at")[:100]
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


@register(("deal",))
def _deal_stage_history(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
    from apps.deals.models import DealStageHistory

    qs = (
        DealStageHistory.objects.filter(deal=record)
        .select_related("from_stage", "to_stage", "changed_by__user")
        .order_by("-changed_at")[:100]
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


@register(("contact", "company"))
def _related_deals(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
    """Deals the actor may see that reference this contact/company (creation events only)."""
    from apps.deals.models import Deal

    cond = (
        Q(company=record) if entity_type == "company" else Q(primary_contact=record) | Q(deal_contacts__contact=record)
    )
    qs = (
        scope(actor, "deals.view", Deal.objects.filter(cond, archived_at__isnull=True))
        .select_related("stage", "created_by__user")
        .distinct()
        .order_by("-created_at")[:50]
    )
    return [
        {
            "id": f"deal:{d.pk}",
            "kind": "deal.linked",
            "occurred_at": d.created_at,
            "actor": _member(d.created_by),
            "data": {
                "deal_id": str(d.pk),
                "name": d.name,
                "status": d.status,
                "stage": d.stage.name,
                "amount": str(d.amount),
                "currency": d.currency,
            },
        }
        for d in qs
    ]
