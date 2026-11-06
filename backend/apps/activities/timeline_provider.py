from __future__ import annotations

from typing import Any

from django.db.models.functions import Coalesce

from apps.activities.models import Activity
from apps.authz.actor import Actor
from apps.authz.service import scope
from apps.notes.timeline import TimelineEvent, Window, member_ref, register


@register(("contact", "company", "deal"), source="activities", label="Activities")
def _activities(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    """Activities linked to the record that the actor may view (owner scope)."""
    qs = window.apply(
        scope(actor, "activities.view", Activity.objects.filter(**{entity_type: record}))
        .select_related("owner__user")
        .annotate(occurred=Coalesce("completed_at", "start_at", "created_at")),
        "occurred",
    )
    events: list[TimelineEvent] = []
    for a in qs:
        occurred = a.occurred
        events.append(
            {
                "id": f"activity:{a.pk}",
                "kind": f"activity.{a.kind}",
                "occurred_at": occurred,
                "actor": member_ref(a.owner),
                "data": {
                    "activity_id": str(a.pk),
                    "activity_kind": a.kind,
                    "title": a.title,
                    "status": a.status,
                    "priority": a.priority,
                    "start_at": a.start_at,
                    "end_at": a.end_at,
                    "completed_at": a.completed_at,
                    "direction": a.direction,
                    "outcome": a.outcome,
                    "duration_minutes": a.duration_minutes,
                    "description": (a.description or "")[:500],
                },
            }
        )
    return events
