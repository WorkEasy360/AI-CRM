"""Rules-based deal risk. Transparent signals, each with the evidence behind it. No model, no guessing.

The assessment is a pure function of a deal row (plus optional counts the caller already has), so it
runs per board card without extra queries and identically inside the daily notification sweep.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

from django.utils import timezone

LEVEL_LOW = "low"
LEVEL_MEDIUM = "medium"
LEVEL_HIGH = "high"

INACTIVE_WARN_DAYS = 7
INACTIVE_HIGH_DAYS = 14
STALE_STAGE_DAYS = 21
STALE_STAGE_HIGH_DAYS = 45


@dataclass
class RiskAssessment:
    level: str
    score: int  # 0 (no risk) .. 100
    reasons: list[str] = field(default_factory=list)
    recommended_action: str = ""
    signals: list[dict[str, Any]] = field(default_factory=list)


def _days(since: dt.datetime | None, now: dt.datetime) -> int | None:
    if since is None:
        return None
    return max(0, (now - since).days)


def assess_deal(deal: Any, *, contact_count: int | None = None, now: dt.datetime | None = None) -> RiskAssessment:
    """``deal`` needs: status, last_activity_at, next_activity_at, stage_entered_at, expected_close_date,
    probability, created_at, primary_contact_id, stage (kind, default_probability)."""
    now = now or timezone.now()
    if getattr(deal, "status", "open") != "open":
        return RiskAssessment(level=LEVEL_LOW, score=0, reasons=["The deal is closed."], recommended_action="")
    points = 0
    reasons: list[str] = []
    signals: list[dict[str, Any]] = []
    actions: list[tuple[int, str]] = []

    last_touch = deal.last_activity_at or deal.stage_entered_at or deal.created_at
    idle = _days(last_touch, now)
    if idle is not None and idle >= INACTIVE_HIGH_DAYS:
        points += 35
        reasons.append(f"No activity for {idle} days.")
        signals.append({"signal": "inactive", "days": idle, "weight": 35})
        actions.append((35, "Schedule a direct follow-up with the decision maker."))
    elif idle is not None and idle >= INACTIVE_WARN_DAYS:
        points += 15
        reasons.append(f"No activity for {idle} days.")
        signals.append({"signal": "inactive", "days": idle, "weight": 15})
        actions.append((15, "Send a follow-up to keep the conversation moving."))

    if deal.next_activity_at is None or deal.next_activity_at < now:
        points += 20
        reasons.append("No next activity scheduled.")
        signals.append({"signal": "no_next_activity", "weight": 20})
        actions.append((20, "Schedule the next call or meeting."))

    if deal.expected_close_date is not None:
        overdue = (now.date() - deal.expected_close_date).days
        if overdue > 0:
            points += 25
            reasons.append(f"Expected close date passed {overdue} days ago.")
            signals.append({"signal": "close_date_overdue", "days": overdue, "weight": 25})
            actions.append((25, "Update the expected close date or move the deal to the right stage."))
        elif overdue > -7 and (deal.next_activity_at is None):
            points += 10
            reasons.append("Closing within a week with nothing scheduled.")
            signals.append({"signal": "closing_soon_no_plan", "weight": 10})
    else:
        points += 5
        reasons.append("No expected close date.")
        signals.append({"signal": "no_close_date", "weight": 5})

    in_stage = _days(deal.stage_entered_at, now)
    stage_name = getattr(getattr(deal, "stage", None), "name", "the current stage")
    if in_stage is not None and in_stage >= STALE_STAGE_HIGH_DAYS:
        points += 25
        reasons.append(f"In {stage_name} for {in_stage} days.")
        signals.append({"signal": "stale_stage", "days": in_stage, "weight": 25})
        actions.append((18, "Review whether the deal is still live or should be closed lost."))
    elif in_stage is not None and in_stage >= STALE_STAGE_DAYS:
        points += 12
        reasons.append(f"In {stage_name} for {in_stage} days.")
        signals.append({"signal": "stale_stage", "days": in_stage, "weight": 12})

    stage_default = getattr(getattr(deal, "stage", None), "default_probability", None)
    if stage_default is not None and deal.probability >= stage_default + 25 and (idle or 0) >= INACTIVE_WARN_DAYS:
        points += 10
        reasons.append(f"Probability {deal.probability}% is well above the stage default with little recent activity.")
        signals.append({"signal": "probability_inconsistent", "weight": 10})
        actions.append((8, "Re-check the probability against what the customer has actually committed to."))

    if getattr(deal, "primary_contact_id", None) is None and (contact_count or 0) == 0:
        points += 10
        reasons.append("No contact linked to the deal.")
        signals.append({"signal": "no_contact", "weight": 10})
        actions.append((10, "Link the decision maker to the deal."))

    score = min(100, points)
    if score >= 50:
        level = LEVEL_HIGH
    elif score >= 25:
        level = LEVEL_MEDIUM
    else:
        level = LEVEL_LOW
    if not reasons:
        reasons.append("Recent activity, a next step planned and the close date ahead.")
    actions.sort(key=lambda a: -a[0])
    return RiskAssessment(
        level=level,
        score=score,
        reasons=reasons,
        recommended_action=actions[0][1] if actions else "",
        signals=signals,
    )


def risk_level(deal: Any) -> str:
    """Cheap level-only variant for list rows and board cards."""
    return assess_deal(deal).level
