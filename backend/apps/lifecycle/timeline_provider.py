from __future__ import annotations

from typing import Any

from apps.authz.actor import Actor
from apps.lifecycle.service import history_for
from apps.notes.timeline import TimelineEvent, member_ref, register


@register(("contact", "company"))
def _lifecycle(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
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
        for h in history_for(entity_type, record.pk)
    ]
