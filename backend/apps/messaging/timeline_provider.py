from __future__ import annotations

from typing import Any

from django.db.models.functions import Coalesce

from apps.authz.actor import Actor
from apps.messaging.models import EmailMessage, WhatsAppMessage
from apps.notes.timeline import TimelineEvent, Window, member_ref, register


@register(("contact", "company", "deal"), source="emails", label="Emails")
def _emails(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    if not actor.has("email.view"):
        return []
    qs = window.apply(
        EmailMessage.objects.filter(**{entity_type: record})
        .select_related("sent_by__user")
        .annotate(occurred=Coalesce("sent_at", "received_at", "created_at")),
        "occurred",
    )
    return [
        {
            "id": f"email:{m.pk}",
            "kind": "email",
            "occurred_at": m.occurred,
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


@register(("contact", "company", "deal"), source="whatsapp", label="WhatsApp")
def _whatsapp(actor: Actor, entity_type: str, record: Any, window: Window) -> list[TimelineEvent]:
    if not actor.has("whatsapp.view"):
        return []
    qs = window.apply(
        WhatsAppMessage.objects.filter(**{entity_type: record})
        .select_related("sent_by__user")
        .annotate(occurred=Coalesce("sent_at", "received_at", "created_at")),
        "occurred",
    )
    return [
        {
            "id": f"whatsapp:{m.pk}",
            "kind": "whatsapp",
            "occurred_at": m.occurred,
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
