from __future__ import annotations

from typing import Any

from apps.authz.actor import Actor
from apps.messaging.models import EmailMessage, WhatsAppMessage
from apps.notes.timeline import TimelineEvent, member_ref, register


@register(("contact", "company", "deal"))
def _emails(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
    if not actor.has("email.view"):
        return []
    qs = (
        EmailMessage.objects.filter(**{entity_type: record})
        .select_related("sent_by__user")
        .order_by("-created_at")[:60]
    )
    return [
        {
            "id": f"email:{m.pk}",
            "kind": "email",
            "occurred_at": m.sent_at or m.received_at or m.created_at,
            "actor": member_ref(m.sent_by),
            "data": {
                "message_id": str(m.pk),
                "direction": m.direction,
                "status": m.status,
                "subject": m.subject,
                "snippet": m.snippet,
                "from_address": m.from_address,
                "to_addresses": m.to_addresses,
                "ai_assisted": m.ai_assisted,
            },
        }
        for m in qs
    ]


@register(("contact", "company", "deal"))
def _whatsapp(actor: Actor, entity_type: str, record: Any) -> list[TimelineEvent]:
    if not actor.has("whatsapp.view"):
        return []
    qs = (
        WhatsAppMessage.objects.filter(**{entity_type: record})
        .select_related("sent_by__user")
        .order_by("-created_at")[:60]
    )
    return [
        {
            "id": f"whatsapp:{m.pk}",
            "kind": "whatsapp",
            "occurred_at": m.sent_at or m.received_at or m.created_at,
            "actor": member_ref(m.sent_by),
            "data": {
                "message_id": str(m.pk),
                "direction": m.direction,
                "status": m.status,
                "message_type": m.message_type,
                "body": m.body[:500],
            },
        }
        for m in qs
    ]
