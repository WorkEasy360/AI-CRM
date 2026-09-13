"""Deal insights: rules-based risk, next best action and the primary contact's lead score.

Everything here is deterministic and computed from data the actor already may see (the deal was
resolved within their view scope by the caller). No LLM call, no external data.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import asdict
from typing import Any

from django.utils import timezone

from apps.ai import nba, risk, scoring
from apps.authz.actor import Actor
from apps.deals.models import Deal, DealContact, DealProduct


def _last_messages(deal: Deal) -> tuple[dt.datetime | None, dt.datetime | None]:
    """Latest outbound / inbound communication timestamps (email, WhatsApp, calls) for the deal."""
    from apps.activities.models import Activity

    outbound: list[dt.datetime] = []
    inbound: list[dt.datetime] = []
    calls = Activity.objects.filter(deal=deal, kind="call", status="completed").order_by("-completed_at")[:5]
    for call in calls:
        when = call.completed_at or call.start_at
        if when is None:
            continue
        (inbound if call.direction == "inbound" else outbound).append(when)
    from apps.messaging.models import EmailMessage, WhatsAppMessage

    for model in (EmailMessage, WhatsAppMessage):
        for row in model.objects.filter(deal=deal).order_by("-created_at")[:10]:
            when = row.received_at or row.sent_at or row.created_at
            (inbound if row.direction == "inbound" else outbound).append(when)
    return (max(outbound) if outbound else None, max(inbound) if inbound else None)


def deal_insights(actor: Actor, deal: Deal) -> dict[str, Any]:
    now = timezone.now()
    contact_count = DealContact.objects.filter(deal=deal).count()
    line_count = DealProduct.objects.filter(deal=deal).count()
    assessment = risk.assess_deal(deal, contact_count=contact_count, now=now)
    last_out, last_in = _last_messages(deal)
    recommendation = nba.recommend(
        deal,
        contact_count=contact_count,
        line_count=line_count,
        last_outbound_at=last_out,
        last_inbound_at=last_in,
        now=now,
    )
    lead = None
    if deal.primary_contact_id and deal.primary_contact is not None:
        facts = scoring.facts_with_engagement(deal.primary_contact, now=now)
        score = scoring.score_contact(facts, now=now)
        lead = {"value": score.value, "label": score.label, "reasons": score.reasons}
    return {
        "computed_at": now,
        "risk": {
            "level": assessment.level,
            "score": assessment.score,
            "label": "Rules-based risk",
            "reasons": assessment.reasons,
            "recommended_action": assessment.recommended_action,
            "signals": assessment.signals,
        },
        "next_best_action": asdict(recommendation) if recommendation else None,
        "lead_score": lead,
        "communication": {"last_outbound_at": last_out, "last_inbound_at": last_in},
    }
