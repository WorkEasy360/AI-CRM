"""Timeline provider: important field changes, read back from the audit log of the record.

Only fields a salesperson cares about are surfaced (owner, amount, close date, probability, status,
lifecycle); everything else stays in the audit log for administrators.
"""

from __future__ import annotations

from typing import Any

from apps.audit.models import AuditEvent
from apps.authz.actor import Actor
from apps.notes.timeline import TimelineEvent, register

IMPORTANT_FIELDS = {
    "deal": ("owner", "amount", "currency", "expected_close_date", "probability", "name", "company", "primary_contact"),
    "contact": ("owner", "company", "email", "phone", "job_title"),
    "company": ("owner", "name", "industry", "website"),
}
LABELS = {
    "owner": "owner",
    "amount": "amount",
    "currency": "currency",
    "expected_close_date": "expected close date",
    "probability": "probability",
    "name": "name",
    "company": "company",
    "primary_contact": "primary contact",
    "email": "email",
    "phone": "phone",
    "job_title": "job title",
    "industry": "industry",
    "website": "website",
}


@register(("contact", "company", "deal"))
def _field_changes(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
    module = {"contact": "contacts", "company": "companies", "deal": "deals"}[entity_type]
    interesting = IMPORTANT_FIELDS[entity_type]
    events: list[TimelineEvent] = []
    rows = (
        AuditEvent.objects.filter(
            resource_type=entity_type,
            resource_id=str(record.pk),
            action__in=[f"{module}.updated", f"{module}.reassigned", f"{module}.archived", f"{module}.restored"],
        )
        .select_related("actor_user")
        .order_by("-created_at")[:60]
    )
    membership_by_user: dict[Any, Any] = {}
    for ev in rows:
        fields = [f for f in (ev.metadata or {}).get("fields", []) if f in interesting]
        if ev.action.endswith(".archived") or ev.action.endswith(".restored"):
            kind = "record.archived" if ev.action.endswith(".archived") else "record.restored"
            fields = []
        elif not fields:
            continue
        else:
            kind = "record.updated"
        actor_ref = None
        if ev.actor_user_id and ev.actor_user is not None:
            actor_ref = membership_by_user.get(ev.actor_user_id)
            if actor_ref is None:
                actor_ref = {"id": str(ev.actor_user_id), "display_name": ev.actor_user.display_name}
                membership_by_user[ev.actor_user_id] = actor_ref
        events.append(
            {
                "id": f"audit:{ev.pk}",
                "kind": kind,
                "occurred_at": ev.created_at,
                "actor": actor_ref,
                "data": {
                    "fields": [LABELS.get(f, f) for f in fields],
                    "owner_from": (ev.metadata or {}).get("owner_from"),
                    "owner_to": (ev.metadata or {}).get("owner_to"),
                },
            }
        )
    return events
