"""Sales dashboard aggregates. Read-only, computed inside the actor's own view scope per module.

Every number here passes through ``authz.scope`` with the same permission the list endpoints use, so
a sales representative's dashboard counts only the records they could open, and a member without
``deals.view`` gets ``None`` for the deal widgets rather than someone else's totals.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, QuerySet, Sum, Value
from django.db.models.functions import Coalesce, TruncMonth
from django.utils import timezone

from apps.authz.actor import Actor
from apps.authz.service import scope
from apps.contacts.models import Contact
from apps.deals.models import Deal
from apps.pipelines.models import Pipeline

PERIODS: dict[str, int] = {"7d": 7, "30d": 30, "90d": 90, "365d": 365}
DEFAULT_PERIOD = "30d"
# A calendar month ("2026-11") is also a period: the dashboard's month selector.
MONTH_PERIOD = re.compile(r"^(20\d{2})-(0[1-9]|1[0-2])$")
TREND_MONTHS = 6
TREND_CHOICES = (3, 6, 12)
TOP_TEAM = 5
HIGH_PROBABILITY = 60
FORECAST_MONTHS = 3
TOP_COMPANIES = 5
TOP_OWNERS = 8
MONEY = DecimalField(max_digits=20, decimal_places=2)


def _money(value: Decimal | None) -> str:
    return str((value or Decimal("0")).quantize(Decimal("0.01")))


def _scoped(actor: Actor, permission: str, queryset: QuerySet) -> QuerySet | None:
    if not actor.has(permission):
        return None
    return scope(actor, permission, queryset)


def _month_start(value):
    return value.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _months_back(value, months: int):
    year, month = value.year, value.month - months
    while month <= 0:
        month += 12
        year -= 1
    return value.replace(year=year, month=month)


def _months_forward(value, months: int):
    year, month = value.year, value.month + months
    while month > 12:
        month -= 12
        year += 1
    return value.replace(year=year, month=month)


def is_period(value: str) -> bool:
    if value in PERIODS:
        return True
    match = MONTH_PERIOD.match(value or "")
    if not match:
        return False
    return (int(match.group(1)), int(match.group(2))) <= (timezone.now().year, timezone.now().month)


def bounds(period: str, now: dt.datetime) -> tuple[dt.datetime, dt.datetime, dt.datetime]:
    """(since, until, before): the window and the start of the same-length window just before it.

    A month runs from its first day (in the server's time zone) to the next month's, or to now for the
    current month; its comparison window is the whole previous month."""
    match = MONTH_PERIOD.match(period)
    if match:
        local = timezone.localtime(now)
        since = local.replace(
            year=int(match.group(1)), month=int(match.group(2)), day=1, hour=0, minute=0, second=0, microsecond=0
        )
        until = min(_months_forward(since, 1), now)
        return since, until, _months_back(since, 1)
    days = PERIODS[period]
    since = now - timedelta(days=days)
    return since, now, since - timedelta(days=days)


def _activity_summary(actor: Actor, *, since, now, until=None, before=None) -> dict[str, Any] | None:
    """Activity counters inside the actor's ``activities.view`` scope (None without the permission)."""
    from apps.activities.models import Activity
    from apps.activities.queries import OPEN_STATUSES

    qs = _scoped(actor, "activities.view", Activity.objects.all())
    if qs is None:
        return None
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_end = today_start + timedelta(days=7)
    until = until or now
    before = before or since - (until - since)
    window = Q(created_at__gte=since, created_at__lt=until)
    previous = Q(created_at__gte=before, created_at__lt=since)
    agg = qs.aggregate(
        tasks_completed=Count(
            "id", filter=Q(kind="task", status="completed", completed_at__gte=since, completed_at__lt=until)
        ),
        meetings_completed=Count(
            "id", filter=Q(kind="meeting", status="completed", completed_at__gte=since, completed_at__lt=until)
        ),
        calls_completed=Count(
            "id", filter=Q(kind="call", status="completed", completed_at__gte=since, completed_at__lt=until)
        ),
        overdue=Count("id", filter=Q(status__in=OPEN_STATUSES, start_at__lt=now)),
        due_week=Count("id", filter=Q(status__in=OPEN_STATUSES, start_at__gte=now, start_at__lt=week_end)),
        due_today=Count(
            "id",
            filter=Q(status__in=OPEN_STATUSES, start_at__gte=today_start, start_at__lt=today_start + timedelta(days=1)),
        ),
        logged=Count("id", filter=window),
        logged_tasks=Count("id", filter=window & Q(kind="task")),
        logged_calls=Count("id", filter=window & Q(kind="call")),
        logged_meetings=Count("id", filter=window & Q(kind="meeting")),
        prev_logged=Count("id", filter=previous),
        prev_logged_tasks=Count("id", filter=previous & Q(kind="task")),
        prev_logged_calls=Count("id", filter=previous & Q(kind="call")),
        prev_logged_meetings=Count("id", filter=previous & Q(kind="meeting")),
        tasks_due=Count(
            "id", filter=Q(kind="task", status__in=OPEN_STATUSES, start_at__lt=today_start + timedelta(days=1))
        ),
        tasks_overdue=Count("id", filter=Q(kind="task", status__in=OPEN_STATUSES, start_at__lt=now)),
        meetings_upcoming=Count(
            "id", filter=Q(kind="meeting", status__in=OPEN_STATUSES, start_at__gte=now, start_at__lt=week_end)
        ),
        calls_upcoming=Count(
            "id", filter=Q(kind="call", status__in=OPEN_STATUSES, start_at__gte=now, start_at__lt=week_end)
        ),
    )
    return agg


def _lead_conversion(contacts: QuerySet, *, since) -> dict[str, Any]:
    """Contacts that became customers in the period against contacts created in it."""
    from apps.lifecycle.models import LifecycleHistory

    created = contacts.filter(created_at__gte=since).count()
    converted = LifecycleHistory.objects.filter(
        entity_type="contact", to_stage="customer", changed_at__gte=since, entity_id__in=contacts.values("pk")
    ).count()
    rate = round(100 * converted / created) if created else None
    return {"created": created, "converted": converted, "rate": rate}


def summary(
    actor: Actor,
    *,
    period: str = DEFAULT_PERIOD,
    pipeline_id: uuid.UUID | None = None,
    trend_months: int = TREND_MONTHS,
) -> dict[str, Any]:
    """Cached per organization + member + permission scope (see ``apps.dashboards.cache``)."""
    from apps.dashboards import cache as dashboard_cache

    return dashboard_cache.get_or_compute(
        actor,
        period=f"{period}:t{trend_months}",
        pipeline_id=pipeline_id,
        compute=lambda: compute_summary(actor, period=period, pipeline_id=pipeline_id, trend_months=trend_months),
    )


def _growth(qs: QuerySet, *, since, until) -> dict[str, int]:
    """How many exist at the end of the window, and how many existed when it started."""
    return {"count": qs.filter(created_at__lt=until).count(), "previous": qs.filter(created_at__lt=since).count()}


def _open_tickets(actor: Actor, *, since, until, before) -> dict[str, Any] | None:
    from apps.helpdesk import services as helpdesk
    from apps.helpdesk.models import Ticket

    tickets = _scoped(actor, "tickets.view", Ticket.objects.all())
    if tickets is None:
        return None
    hours = helpdesk.sla_hours(actor.organization)
    return tickets.aggregate(
        open=Count("id", filter=Q(status__in=helpdesk.ACTIVE_STATUSES)),
        overdue=Count("id", filter=helpdesk.overdue_q(hours)),
        created=Count("id", filter=Q(created_at__gte=since, created_at__lt=until)),
        created_previous=Count("id", filter=Q(created_at__gte=before, created_at__lt=since)),
    )


def compute_summary(
    actor: Actor,
    *,
    period: str = DEFAULT_PERIOD,
    pipeline_id: uuid.UUID | None = None,
    trend_months: int = TREND_MONTHS,
) -> dict[str, Any]:
    now = timezone.now()
    since, until, before = bounds(period, now)
    out: dict[str, Any] = {
        "period": period,
        "since": since,
        "until": until,
        "currency": actor.organization.base_currency,
        "activities": _activity_summary(actor, since=since, now=now, until=until, before=before),
        "tickets": _open_tickets(actor, since=since, until=until, before=before),
    }

    from apps.companies.models import Company

    contacts = _scoped(actor, "contacts.view", Contact.objects.filter(archived_at__isnull=True))
    companies = _scoped(actor, "companies.view", Company.objects.filter(archived_at__isnull=True))
    out["contacts_created"] = (
        None if contacts is None else contacts.filter(created_at__gte=since, created_at__lt=until).count()
    )
    out["lead_conversion"] = None if contacts is None else _lead_conversion(contacts, since=since)
    out["totals"] = {
        "contacts": None if contacts is None else _growth(contacts, since=since, until=until),
        "companies": None if companies is None else _growth(companies, since=since, until=until),
    }

    deals = _scoped(actor, "deals.view", Deal.objects.filter(archived_at__isnull=True))
    out["totals"]["deals"] = None if deals is None else _growth(deals, since=since, until=until)
    if deals is None:
        for key in (
            "deals_won",
            "deals_lost",
            "open_pipeline",
            "weighted_pipeline",
            "win_rate",
            "average_deal_size",
            "deals_by_stage",
            "deals_by_owner",
            "revenue_trend",
            "forecast",
            "top_companies",
            "deals_created",
            "previous",
            "deals_by_source",
            "top_team",
            "deals_closing_week",
        ):
            out[key] = None
        out["insights"] = _insights(actor, out, deals=None, now=now)
        return out

    # One pass over the actor's deals with conditional aggregates instead of three scans. The previous
    # period (same length, just before) feeds the "vs previous" changes on the dashboard tiles.
    won_q = Q(status=Deal.Status.WON, closed_at__gte=since, closed_at__lt=until)
    lost_q = Q(status=Deal.Status.LOST, closed_at__gte=since, closed_at__lt=until)
    prev_won_q = Q(status=Deal.Status.WON, closed_at__gte=before, closed_at__lt=since)
    prev_lost_q = Q(status=Deal.Status.LOST, closed_at__gte=before, closed_at__lt=since)
    open_q = Q(status=Deal.Status.OPEN)
    weighted = ExpressionWrapper(F("amount_base") * F("probability") / Value(100), output_field=MONEY)
    agg = deals.aggregate(
        won_count=Count("id", filter=won_q),
        won_amount=Sum("amount_base", filter=won_q),
        lost_count=Count("id", filter=lost_q),
        lost_amount=Sum("amount_base", filter=lost_q),
        open_count=Count("id", filter=open_q),
        open_amount=Sum("amount_base", filter=open_q),
        weighted_amount=Sum(weighted, filter=open_q),
        created_count=Count("id", filter=Q(created_at__gte=since, created_at__lt=until)),
        prev_created_count=Count("id", filter=Q(created_at__gte=before, created_at__lt=since)),
        prev_won_count=Count("id", filter=prev_won_q),
        prev_won_amount=Sum("amount_base", filter=prev_won_q),
        prev_lost_count=Count("id", filter=prev_lost_q),
    )
    out["deals_won"] = {"count": agg["won_count"], "amount": _money(agg["won_amount"])}
    out["deals_lost"] = {"count": agg["lost_count"], "amount": _money(agg["lost_amount"])}
    out["open_pipeline"] = {"count": agg["open_count"], "amount": _money(agg["open_amount"])}
    out["weighted_pipeline"] = {"count": agg["open_count"], "amount": _money(agg["weighted_amount"])}
    closed = agg["won_count"] + agg["lost_count"]
    out["win_rate"] = round(100 * agg["won_count"] / closed) if closed else None
    out["average_deal_size"] = _money(Decimal(agg["won_amount"] or 0) / agg["won_count"]) if agg["won_count"] else None
    out["deals_created"] = agg["created_count"]
    prev_closed = agg["prev_won_count"] + agg["prev_lost_count"]
    out["previous"] = {
        "since": before,
        "deals_created": agg["prev_created_count"],
        "deals_won": {"count": agg["prev_won_count"], "amount": _money(agg["prev_won_amount"])},
        "win_rate": round(100 * agg["prev_won_count"] / prev_closed) if prev_closed else None,
    }

    pipelines = Pipeline.objects.filter(archived_at__isnull=True)
    pipeline = pipelines.filter(pk=pipeline_id).first() if pipeline_id else None
    if pipeline is None:
        pipeline = pipelines.order_by("-is_default", "position").first()
    if pipeline is None:
        out["deals_by_stage"] = {"pipeline": None, "stages": []}
    else:
        per_stage = {
            row["stage_id"]: row
            for row in deals.filter(pipeline=pipeline)
            .values("stage_id")
            .annotate(count=Count("id"), amount=Sum("amount_base"))
            .order_by()
        }
        stages = []
        for stage in pipeline.stages.filter(archived_at__isnull=True).order_by("position"):
            row = per_stage.get(stage.pk, {})
            stages.append(
                {
                    "id": str(stage.pk),
                    "name": stage.name,
                    "kind": stage.kind,
                    "color_token": stage.color_token,
                    "count": row.get("count", 0),
                    "amount": _money(row.get("amount")),
                }
            )
        out["deals_by_stage"] = {"pipeline": {"id": str(pipeline.pk), "name": pipeline.name}, "stages": stages}

    trend_end = _month_start(timezone.localtime(until - timedelta(microseconds=1)))
    trend_start = _months_back(trend_end, trend_months - 1)
    by_month = {
        row["month"].date().isoformat()[:7]: row
        for row in deals.filter(
            status=Deal.Status.WON, closed_at__gte=trend_start, closed_at__lt=_months_forward(trend_end, 1)
        )
        .annotate(month=TruncMonth("closed_at"))
        .values("month")
        .annotate(count=Count("id"), amount=Sum("amount_base"))
        .order_by()
    }
    trend = []
    for i in range(trend_months):
        month = _months_back(trend_end, trend_months - 1 - i)
        key = month.date().isoformat()[:7]
        row = by_month.get(key, {})
        trend.append({"month": key, "count": row.get("count", 0), "amount": _money(row.get("amount"))})
    out["revenue_trend"] = trend

    # Forecast: weighted open pipeline by expected close month for the next months (server-side arithmetic).
    forecast_start = _month_start(now)
    forecast_end = _months_forward(forecast_start, FORECAST_MONTHS)
    by_close_month = {
        row["month"].isoformat()[:7]: row
        for row in deals.filter(
            status=Deal.Status.OPEN,
            expected_close_date__gte=forecast_start.date(),
            expected_close_date__lt=forecast_end.date(),
        )
        .annotate(month=TruncMonth("expected_close_date"))
        .values("month")
        .annotate(count=Count("id"), amount=Sum("amount_base"), weighted=Sum(weighted))
        .order_by()
        if row["month"] is not None
    }
    forecast = []
    for i in range(FORECAST_MONTHS):
        month = _months_forward(forecast_start, i)
        key = month.date().isoformat()[:7]
        row = by_close_month.get(key, {})
        forecast.append(
            {
                "month": key,
                "count": row.get("count", 0),
                "amount": _money(row.get("amount")),
                "weighted": _money(row.get("weighted")),
            }
        )
    out["forecast"] = forecast

    owners = (
        deals.filter(status=Deal.Status.OPEN, owner__isnull=False)
        .values("owner_id", "owner__user__first_name", "owner__user__last_name", "owner__user__email")
        .annotate(
            count=Count("id"),
            amount=Coalesce(Sum("amount_base"), Value(Decimal("0"), output_field=MONEY)),
            weighted=Sum(weighted),
        )
        .order_by("-amount")[:TOP_OWNERS]
    )
    out["deals_by_owner"] = [
        {
            "id": str(row["owner_id"]),
            "name": f"{row['owner__user__first_name']} {row['owner__user__last_name']}".strip()
            or (row["owner__user__email"] or "").split("@")[0],
            "count": row["count"],
            "amount": _money(row["amount"]),
            "weighted": _money(row["weighted"]),
        }
        for row in owners
    ]

    top = (
        deals.filter(status__in=[Deal.Status.OPEN, Deal.Status.WON], company__isnull=False)
        .values("company_id", "company__name")
        .annotate(count=Count("id"), amount=Sum("amount_base"))
        .order_by("-amount", "company__name")[:TOP_COMPANIES]
    )
    out["top_companies"] = [
        {
            "id": str(row["company_id"]),
            "name": row["company__name"],
            "count": row["count"],
            "amount": _money(row["amount"]),
        }
        for row in top
    ]

    # Deals by source: deals created in the window, by where they came from ("" = not recorded).
    out["deals_by_source"] = [
        {"source": row["lead_source"] or "", "count": row["n"]}
        for row in deals.filter(created_at__gte=since, created_at__lt=until)
        .values("lead_source")
        .annotate(n=Count("id"))
        .order_by("-n", "lead_source")
    ]

    # Top performing team: deals won in the window and the revenue they brought, per owner.
    team = (
        deals.filter(won_q, owner__isnull=False)
        .values("owner_id", "owner__user__first_name", "owner__user__last_name", "owner__user__email")
        .annotate(count=Count("id"), amount=Sum("amount_base"))
        .order_by("-amount", "-count")[:TOP_TEAM]
    )
    out["top_team"] = [
        {
            "id": str(row["owner_id"]),
            "name": f"{row['owner__user__first_name']} {row['owner__user__last_name']}".strip()
            or (row["owner__user__email"] or "").split("@")[0],
            "count": row["count"],
            "amount": _money(row["amount"]),
        }
        for row in team
    ]
    today = timezone.localdate()
    out["deals_closing_week"] = deals.filter(
        status=Deal.Status.OPEN, expected_close_date__gte=today, expected_close_date__lte=today + timedelta(days=7)
    ).count()
    out["insights"] = _insights(actor, out, deals=deals, now=now)
    return out


def _insights(actor: Actor, out: dict[str, Any], *, deals: QuerySet | None, now) -> list[dict[str, Any]]:
    """Short, computed observations for the WorkEasy AI Insights card. Each is a count over data the
    actor may already see; the client words them and links each to the filtered list."""
    items: list[dict[str, Any]] = []
    activities = out.get("activities")
    if activities and activities.get("due_today"):
        items.append({"key": "follow_ups_today", "count": activities["due_today"]})
    if deals is not None:
        soon = timezone.localdate() + timedelta(days=30)
        close = deals.filter(
            status=Deal.Status.OPEN, probability__gte=HIGH_PROBABILITY, expected_close_date__lte=soon
        ).aggregate(n=Count("id"), amount=Sum("amount_base"))
        if close["n"]:
            items.append({"key": "deals_close_to_winning", "count": close["n"], "amount": _money(close["amount"])})
        previous = (out.get("previous") or {}).get("win_rate")
        if out.get("win_rate") is not None and previous is not None and out["win_rate"] != previous:
            items.append({"key": "win_rate_change", "points": out["win_rate"] - previous, "current": out["win_rate"]})
        idle = deals.filter(status=Deal.Status.OPEN, next_activity_at__isnull=True).count()
        if idle:
            items.append({"key": "deals_without_next_step", "count": idle})
    tickets = out.get("tickets")
    if tickets and tickets.get("overdue"):
        items.append({"key": "tickets_overdue", "count": tickets["overdue"]})
    return items[:4]
