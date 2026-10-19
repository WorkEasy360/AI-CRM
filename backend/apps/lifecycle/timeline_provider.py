from __future__ import annotations

from typing import Any

from apps.authz.actor import Actor
from apps.lifecycle.models import LifecycleHistory
from apps.notes.timeline import TimelineEvent, Window, member_ref, register


@register(("contact", "company"), source="lifecycle", label="Lifecycle")
def _lifecycle(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    rows = window.apply(
        LifecycleHistory.objects.filter(entity_type=entity_type, entity_id=record.pk).select_related(
            "changed_by__user"
        ),
        "changed_at",
    )
    return [
        {
            "id": f"lifecycle:{h.pk}",
            "kind": "lifecycle.changed",
            "occurred_at": h.changed_at,
            "actor": member_ref(h.changed_by),
            "data": {
                "from_stage": h.from_stage or None,
                "to_stage": h.to_stage,
                "source": h.source,
                "reason": h.reason,
            },
        }
        for h in rows
    ]
