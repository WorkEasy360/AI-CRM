"""Pipeline headline figures and analytics, over a deal queryset the caller has already scoped.

Callers pass ``deals`` = the actor's ``deals.view`` scope, restricted to one pipeline they may access, with
their list filters applied. Nothing here widens that set; money is left out when the amount field is hidden.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from django.db.models import Avg, Count, DecimalField, DurationField, ExpressionWrapper, F, Q, QuerySet, Sum, Value
from django.utils import timezone

from apps.deals.models import Deal, DealStageHistory

PERIOD_DAYS = 30
TOP_OWNERS = 10
TOP_LOST_REASONS = 5

_WEIGHTED = ExpressionWrapper(
    F("amount_base") * F("probability") / Value(Decimal(100)),
    output_field=DecimalField(max_digits=22, decimal_places=4),
)
_CYCLE = ExpressionWrapper(F("closed_at") - F("created_at"), output_field=DurationField())


def _money(value: Any, hide: bool) -> str | None:
    if hide:
        return None
    return str((value or Decimal("0")).quantize(Decimal("0.01")))


def _rate(won: int, lost: int) -> float | None:
    return round(100 * won / (won + lost), 1) if won + lost else None


def _window(deals: QuerySet, start: dt.datetime, end: dt.datetime) -> dict[str, Any]:
    closed = deals.filter(closed_at__gte=start, closed_at__lt=end)
    agg = closed.aggregate(
        won=Count("id", filter=Q(status=Deal.Status.WON)),
        lost=Count("id", filter=Q(status=Deal.Status.LOST)),
    )
    cycle = closed.filter(status=Deal.Status.WON).annotate(took=_CYCLE).aggregate(avg=Avg("took"))["avg"]
    return {
        "created": deals.filter(created_at__gte=start, created_at__lt=end).count(),
        "won": agg["won"],
        "lost": agg["lost"],
        "win_rate": _rate(agg["won"], agg["lost"]),
        "avg_cycle_days": round(cycle.total_seconds() / 86400, 1) if cycle is not None else None,
    }


def stats(deals: QuerySet, *, hide_money: bool, now: dt.datetime | None = None, days: int = PERIOD_DAYS) -> dict:
    """Total deals, open pipeline value, weighted expected revenue, win rate and deal cycle, with the
    previous ``days`` to compare (win rate and cycle use deals closed in each window)."""
    now = now or timezone.now()
    since = now - dt.timedelta(days=days)
    before = since - dt.timedelta(days=days)
    totals = deals.aggregate(
        total=Count("id"),
        open=Count("id", filter=Q(status=Deal.Status.OPEN)),
        value=Sum("amount_base", filter=Q(status=Deal.Status.OPEN)),
        expected=Sum(_WEIGHTED, filter=Q(status=Deal.Status.OPEN)),
    )
    return {
        "days": days,
        "total_deals": totals["total"],
        "open_deals": totals["open"],
        "pipeline_value": _money(totals["value"], hide_money),
        "expected_revenue": _money(totals["expected"], hide_money),
        "current": _window(deals, since, now),
        "previous": _window(deals, before, since),
    }


def analytics(deals: QuerySet, stages: list, *, hide_money: bool) -> dict:
    """Stage conversion, win/loss, lead sources and owner performance for the board's deal set."""
    reached = {
        row["to_stage_id"]: row["n"]
        for row in DealStageHistory.objects.filter(deal__in=deals.values("pk"), to_stage__in=[s.pk for s in stages])
        .values("to_stage_id")
        .annotate(n=Count("deal_id", distinct=True))
        .order_by()
    }
    current = {row["stage_id"]: row["n"] for row in deals.values("stage_id").annotate(n=Count("id")).order_by()}
    first = reached.get(stages[0].pk, 0) if stages else 0
    conversion = [
        {
            "id": str(stage.pk),
            "name": stage.name,
            "kind": stage.kind,
            "color_token": stage.color_token,
            "reached": reached.get(stage.pk, 0),
            "current": current.get(stage.pk, 0),
            "rate": round(100 * reached.get(stage.pk, 0) / first, 1) if first else None,
        }
        for stage in stages
    ]

    outcome = deals.aggregate(
        won=Count("id", filter=Q(status=Deal.Status.WON)),
        lost=Count("id", filter=Q(status=Deal.Status.LOST)),
        open=Count("id", filter=Q(status=Deal.Status.OPEN)),
        won_amount=Sum("amount_base", filter=Q(status=Deal.Status.WON)),
        lost_amount=Sum("amount_base", filter=Q(status=Deal.Status.LOST)),
    )
    reasons = [
        {"reason": row["lost_reason"], "count": row["n"]}
        for row in deals.filter(status=Deal.Status.LOST)
        .exclude(lost_reason="")
        .values("lost_reason")
        .annotate(n=Count("id"))
        .order_by("-n", "lost_reason")[:TOP_LOST_REASONS]
    ]

    labels = dict(Deal.LeadSource.choices)
    sources = [
        {
            "source": row["lead_source"] or "",
            "label": labels.get(row["lead_source"], "Not set") if row["lead_source"] else "Not set",
            "count": row["n"],
            "won": row["won"],
            "won_amount": _money(row["won_amount"], hide_money),
        }
        for row in deals.values("lead_source")
        .annotate(
            n=Count("id"),
            won=Count("id", filter=Q(status=Deal.Status.WON)),
            won_amount=Sum("amount_base", filter=Q(status=Deal.Status.WON)),
        )
        .order_by("-n")
    ]

    owners = []
    for row in (
        deals.filter(owner__isnull=False)
        .values("owner_id", "owner__user__first_name", "owner__user__last_name", "owner__user__email")
        .annotate(
            n=Count("id"),
            won=Count("id", filter=Q(status=Deal.Status.WON)),
            lost=Count("id", filter=Q(status=Deal.Status.LOST)),
            won_amount=Sum("amount_base", filter=Q(status=Deal.Status.WON)),
        )
        .order_by("-won", "-n")[:TOP_OWNERS]
    ):
        name = f"{row['owner__user__first_name']} {row['owner__user__last_name']}".strip()
        owners.append(
            {
                "id": str(row["owner_id"]),
                "name": name or (row["owner__user__email"] or "").split("@")[0],
                "deals": row["n"],
                "won": row["won"],
                "win_rate": _rate(row["won"], row["lost"]),
                "won_amount": _money(row["won_amount"], hide_money),
            }
        )

    return {
        "conversion": conversion,
        "win_loss": {
            "won": outcome["won"],
            "lost": outcome["lost"],
            "open": outcome["open"],
            "win_rate": _rate(outcome["won"], outcome["lost"]),
            "won_amount": _money(outcome["won_amount"], hide_money),
            "lost_amount": _money(outcome["lost_amount"], hide_money),
            "lost_reasons": reasons,
        },
        "sources": sources,
        "owners": owners,
    }
