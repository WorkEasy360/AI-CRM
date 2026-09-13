"""Deterministic sales forecast (no fake AI): pipeline, weighted, committed, best case and won revenue.

Every number is computed inside the actor's ``deals.view`` scope, on ``amount_base`` (ADR-0012), for
open deals whose expected close date falls in the period plus deals already won in it. Confidence is
expressed as coverage (how many deals have no close date) rather than a made-up percentage.
"""

from __future__ import annotations

import calendar
import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, QuerySet, Sum, Value
from django.db.models.functions import Coalesce, TruncMonth
from django.utils import timezone

from apps.authz.actor import Actor
from apps.authz.service import scope
from apps.deals.models import Deal
from apps.pipelines.models import Pipeline

COMMITTED_PROBABILITY = 75
MAX_CUSTOM_DAYS = 366
GROUP_BYS = ("stage", "owner", "pipeline", "team")
PERIODS = ("month", "quarter", "custom")
MONEY = DecimalField(max_digits=20, decimal_places=2)


def _money(value: Any) -> str:
    return str((Decimal(value or 0)).quantize(Decimal("0.01")))


def period_bounds(
    period: str, *, today: dt.date, start: dt.date | None = None, end: dt.date | None = None
) -> tuple[dt.date, dt.date]:
    if period == "month":
        first = today.replace(day=1)
        return first, first.replace(day=calendar.monthrange(first.year, first.month)[1])
    if period == "quarter":
        q_start_month = 3 * ((today.month - 1) // 3) + 1
        first = today.replace(month=q_start_month, day=1)
        last_month = q_start_month + 2
        return first, first.replace(month=last_month, day=calendar.monthrange(first.year, last_month)[1])
    if period == "custom":
        if start is None or end is None:
            raise ValueError("custom period needs from and to")
        if end < start or (end - start).days > MAX_CUSTOM_DAYS:
            raise ValueError("range too long")
        return start, end
    raise ValueError("unknown period")


def _weighted() -> ExpressionWrapper:
    return ExpressionWrapper(F("amount_base") * F("probability") / Value(100), output_field=MONEY)


def _totals(open_in_period: QuerySet, won_in_period: QuerySet, lost_in_period: QuerySet) -> dict[str, Any]:
    o = open_in_period.aggregate(
        count=Count("id"),
        amount=Coalesce(Sum("amount_base"), Value(Decimal("0"), output_field=MONEY)),
        weighted=Coalesce(Sum(_weighted()), Value(Decimal("0"), output_field=MONEY)),
        committed=Coalesce(
            Sum("amount_base", filter=Q(probability__gte=COMMITTED_PROBABILITY)),
            Value(Decimal("0"), output_field=MONEY),
        ),
        committed_count=Count("id", filter=Q(probability__gte=COMMITTED_PROBABILITY)),
    )
    w = won_in_period.aggregate(
        count=Count("id"), amount=Coalesce(Sum("amount_base"), Value(Decimal("0"), output_field=MONEY))
    )
    lost = lost_in_period.aggregate(
        count=Count("id"), amount=Coalesce(Sum("amount_base"), Value(Decimal("0"), output_field=MONEY))
    )
    return {
        "pipeline": {"count": o["count"], "amount": _money(o["amount"])},
        "weighted": {"count": o["count"], "amount": _money(o["weighted"])},
        "committed": {"count": o["committed_count"], "amount": _money(o["committed"])},
        "best_case": {"count": o["count"] + w["count"], "amount": _money(Decimal(o["amount"]) + Decimal(w["amount"]))},
        "won": {"count": w["count"], "amount": _money(w["amount"])},
        "lost": {"count": lost["count"], "amount": _money(lost["amount"])},
        "expected_revenue": _money(Decimal(o["weighted"]) + Decimal(w["amount"])),
    }


def compute_forecast(
    actor: Actor,
    *,
    period: str = "month",
    start: dt.date | None = None,
    end: dt.date | None = None,
    pipeline_id: uuid.UUID | None = None,
    group_by: str = "stage",
) -> dict[str, Any]:
    if group_by not in GROUP_BYS:
        raise ValueError("unknown group_by")
    now = timezone.now()
    first, last = period_bounds(period, today=now.date(), start=start, end=end)
    deals = scope(actor, "deals.view", Deal.objects.filter(archived_at__isnull=True))
    pipelines = Pipeline.objects.filter(archived_at__isnull=True)
    pipeline = pipelines.filter(pk=pipeline_id).first() if pipeline_id else None
    if pipeline is not None:
        deals = deals.filter(pipeline=pipeline)
    open_deals = deals.filter(status=Deal.Status.OPEN)
    open_in_period = open_deals.filter(expected_close_date__gte=first, expected_close_date__lte=last)
    won_in_period = deals.filter(status=Deal.Status.WON, closed_at__date__gte=first, closed_at__date__lte=last)
    lost_in_period = deals.filter(status=Deal.Status.LOST, closed_at__date__gte=first, closed_at__date__lte=last)

    totals = _totals(open_in_period, won_in_period, lost_in_period)
    coverage = open_deals.aggregate(
        total=Count("id"),
        without_close_date=Count("id", filter=Q(expected_close_date__isnull=True)),
        overdue=Count("id", filter=Q(expected_close_date__lt=now.date())),
    )

    # Breakdown rows for the chosen dimension.
    key_fields: tuple[str, ...]
    if group_by == "stage":
        key_fields = ("stage_id", "stage__name", "stage__position")
        label = lambda row: row["stage__name"]  # noqa: E731
        ident = lambda row: str(row["stage_id"])  # noqa: E731
        order = ("stage__position",)
    elif group_by == "owner":
        key_fields = ("owner_id", "owner__user__first_name", "owner__user__last_name", "owner__user__email")
        label = lambda row: (  # noqa: E731
            f"{row['owner__user__first_name']} {row['owner__user__last_name']}".strip()
            or (row["owner__user__email"] or "").split("@")[0]
            or "Unassigned"
        )
        ident = lambda row: str(row["owner_id"]) if row["owner_id"] else ""  # noqa: E731
        order = ("-weighted",)
    elif group_by == "pipeline":
        key_fields = ("pipeline_id", "pipeline__name")
        label = lambda row: row["pipeline__name"]  # noqa: E731
        ident = lambda row: str(row["pipeline_id"])  # noqa: E731
        order = ("pipeline__name",)
    else:  # team: owner's first team (a member in several teams counts once, in the first by name)
        key_fields = ("owner_id",)
        label = None
        ident = lambda row: str(row["owner_id"]) if row["owner_id"] else ""  # noqa: E731
        order = ("-weighted",)

    open_rows = list(
        open_in_period.values(*key_fields)
        .annotate(
            count=Count("id"),
            amount=Coalesce(Sum("amount_base"), Value(Decimal("0"), output_field=MONEY)),
            weighted=Coalesce(Sum(_weighted()), Value(Decimal("0"), output_field=MONEY)),
            committed=Coalesce(
                Sum("amount_base", filter=Q(probability__gte=COMMITTED_PROBABILITY)),
                Value(Decimal("0"), output_field=MONEY),
            ),
        )
        .order_by(*order)[:50]
    )
    won_rows = {
        tuple(row[k] for k in key_fields): row
        for row in won_in_period.values(*key_fields).annotate(
            won_count=Count("id"), won_amount=Coalesce(Sum("amount_base"), Value(Decimal("0"), output_field=MONEY))
        )
    }
    breakdown: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for row in open_rows:
        key = tuple(row[k] for k in key_fields)
        seen.add(key)
        won = won_rows.get(key, {})
        breakdown.append(
            {
                "id": ident(row),
                "label": label(row) if label else "",
                "count": row["count"],
                "amount": _money(row["amount"]),
                "weighted": _money(row["weighted"]),
                "committed": _money(row["committed"]),
                "won_count": won.get("won_count", 0),
                "won_amount": _money(won.get("won_amount")),
            }
        )
    for key, won in won_rows.items():
        if key in seen:
            continue
        breakdown.append(
            {
                "id": ident(won),
                "label": label(won) if label else "",
                "count": 0,
                "amount": "0.00",
                "weighted": "0.00",
                "committed": "0.00",
                "won_count": won["won_count"],
                "won_amount": _money(won["won_amount"]),
            }
        )
    if group_by == "team":
        breakdown = _roll_up_by_team(breakdown)

    # Monthly series across the period by expected close month (open, weighted) and close month (won).
    series = _monthly_series(open_in_period, won_in_period, first, last)

    return {
        "period": period,
        "from": first,
        "to": last,
        "currency": actor.organization.base_currency,
        "pipeline": {"id": str(pipeline.pk), "name": pipeline.name} if pipeline else None,
        "group_by": group_by,
        "totals": totals,
        "coverage": {
            "open_deals": coverage["total"],
            "in_period": totals["pipeline"]["count"],
            "without_close_date": coverage["without_close_date"],
            "overdue": coverage["overdue"],
        },
        "breakdown": breakdown,
        "series": series,
        "committed_probability": COMMITTED_PROBABILITY,
    }


def _roll_up_by_team(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from apps.teams.models import TeamMembership

    member_ids = [uuid.UUID(r["id"]) for r in rows if r["id"]]
    team_of: dict[str, tuple[str, str]] = {}
    for tm in TeamMembership.objects.filter(membership_id__in=member_ids).select_related("team").order_by("team__name"):
        team_of.setdefault(str(tm.membership_id), (str(tm.team_id), tm.team.name))
    grouped: dict[str, dict[str, Any]] = {}
    for r in rows:
        team_id, team_name = team_of.get(r["id"], ("", "No team"))
        g = grouped.setdefault(
            team_id,
            {
                "id": team_id,
                "label": team_name,
                "count": 0,
                "amount": Decimal(0),
                "weighted": Decimal(0),
                "committed": Decimal(0),
                "won_count": 0,
                "won_amount": Decimal(0),
            },
        )
        g["count"] += r["count"]
        g["amount"] += Decimal(r["amount"])
        g["weighted"] += Decimal(r["weighted"])
        g["committed"] += Decimal(r["committed"])
        g["won_count"] += r["won_count"]
        g["won_amount"] += Decimal(r["won_amount"])
    out = []
    for g in sorted(grouped.values(), key=lambda x: -x["weighted"]):
        out.append(
            {
                **g,
                "amount": _money(g["amount"]),
                "weighted": _money(g["weighted"]),
                "committed": _money(g["committed"]),
                "won_amount": _money(g["won_amount"]),
            }
        )
    return out


def _monthly_series(open_qs: QuerySet, won_qs: QuerySet, first: dt.date, last: dt.date) -> list[dict[str, Any]]:
    by_month: dict[str, dict[str, Any]] = {}
    for row in (
        open_qs.annotate(month=TruncMonth("expected_close_date"))
        .values("month")
        .annotate(
            count=Count("id"),
            amount=Coalesce(Sum("amount_base"), Value(Decimal("0"), output_field=MONEY)),
            weighted=Coalesce(Sum(_weighted()), Value(Decimal("0"), output_field=MONEY)),
        )
        .order_by()
    ):
        if row["month"] is None:
            continue
        key = row["month"].isoformat()[:7]
        by_month.setdefault(key, {})["open"] = row
    for row in (
        won_qs.annotate(month=TruncMonth("closed_at"))
        .values("month")
        .annotate(count=Count("id"), amount=Coalesce(Sum("amount_base"), Value(Decimal("0"), output_field=MONEY)))
        .order_by()
    ):
        if row["month"] is None:
            continue
        key = row["month"].date().isoformat()[:7] if hasattr(row["month"], "date") else row["month"].isoformat()[:7]
        by_month.setdefault(key, {})["won"] = row
    series = []
    cursor = first.replace(day=1)
    while cursor <= last:
        key = cursor.isoformat()[:7]
        o = by_month.get(key, {}).get("open", {})
        w = by_month.get(key, {}).get("won", {})
        series.append(
            {
                "month": key,
                "open_count": o.get("count", 0),
                "pipeline": _money(o.get("amount")),
                "weighted": _money(o.get("weighted")),
                "won_count": w.get("count", 0),
                "won": _money(w.get("amount")),
            }
        )
        cursor = (cursor.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    return series
