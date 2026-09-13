"""Next best action: rules over the deal's facts. The LLM never invents actions; at most it rephrases."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

from django.utils import timezone


@dataclass
class Recommendation:
    action: str  # short label, e.g. "Send follow-up"
    reason: str
    evidence: list[str] = field(default_factory=list)
    kind: str = ""  # machine key: call | follow_up | meeting | proposal | decision_maker | pricing | reengage | close
    confidence: str = "medium"  # high | medium | low


def recommend(
    deal: Any,
    *,
    contact_count: int = 0,
    line_count: int = 0,
    last_outbound_at: dt.datetime | None = None,
    last_inbound_at: dt.datetime | None = None,
    now: dt.datetime | None = None,
) -> Recommendation | None:
    now = now or timezone.now()
    if getattr(deal, "status", "open") != "open":
        return None
    stage = getattr(deal, "stage", None)
    stage_name = (getattr(stage, "name", "") or "").lower()
    last_touch = deal.last_activity_at or deal.stage_entered_at or deal.created_at
    idle = (now - last_touch).days if last_touch else None
    in_stage = (now - deal.stage_entered_at).days if deal.stage_entered_at else 0

    if deal.expected_close_date and deal.expected_close_date < now.date():
        return Recommendation(
            kind="close",
            action="Update the close date or close the deal",
            reason="The expected close date has passed while the deal is still open.",
            evidence=[
                f"Expected close {deal.expected_close_date.isoformat()}",
                f"Status open in {getattr(stage, 'name', 'stage')}",
            ],
            confidence="high",
        )
    if idle is not None and idle >= 14:
        return Recommendation(
            kind="reengage",
            action="Re-engage the account",
            reason=f"Nothing has happened on this deal for {idle} days.",
            evidence=[f"Last activity {last_touch.date().isoformat()}"],
            confidence="high",
        )
    if last_outbound_at and (last_inbound_at is None or last_inbound_at < last_outbound_at):
        waiting = (now - last_outbound_at).days
        if waiting >= 3:
            return Recommendation(
                kind="call",
                action="Call the customer",
                reason=f"Your last message went out {waiting} days ago and has not been answered.",
                evidence=[f"Last outbound {last_outbound_at.date().isoformat()}", "No reply since"],
                confidence="high" if waiting >= 5 else "medium",
            )
    if "proposal" in stage_name and line_count == 0:
        return Recommendation(
            kind="proposal",
            action="Send the proposal",
            reason="The deal is in the proposal stage without any products or a quote attached.",
            evidence=["Stage: Proposal", "0 product lines"],
            confidence="medium",
        )
    if "negotiation" in stage_name and in_stage >= 10:
        return Recommendation(
            kind="pricing",
            action="Review pricing and ask for a decision",
            reason=f"The deal has been in negotiation for {in_stage} days.",
            evidence=[f"Stage entered {deal.stage_entered_at.date().isoformat()}"],
            confidence="medium",
        )
    if deal.primary_contact_id is None and contact_count == 0:
        return Recommendation(
            kind="decision_maker",
            action="Contact the decision maker",
            reason="No contact is linked to this deal yet.",
            evidence=["0 linked contacts"],
            confidence="high",
        )
    if deal.next_activity_at is None or deal.next_activity_at < now:
        if idle is not None and idle >= 5:
            return Recommendation(
                kind="follow_up",
                action="Send a follow-up",
                reason=f"The last activity was {idle} days ago and nothing is scheduled next.",
                evidence=[f"Last activity {last_touch.date().isoformat()}", "No next activity"],
                confidence="medium",
            )
        return Recommendation(
            kind="meeting",
            action="Schedule the next meeting",
            reason="There is no next step on the calendar for this deal.",
            evidence=["No next activity scheduled"],
            confidence="medium",
        )
    return Recommendation(
        kind="follow_up",
        action="Keep the next activity on track",
        reason="A next step is scheduled; prepare for it.",
        evidence=[f"Next activity {deal.next_activity_at.isoformat(timespec='minutes')}"],
        confidence="low",
    )
