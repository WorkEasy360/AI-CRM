"""Structured CRM answers: SQL, not similarity.

PostgreSQL is the source of truth. Anything countable, addable or sortable is answered here with an
ordinary authorized query -- the same query the list and dashboard endpoints use, through the same
``authz.scope`` -- and the number that comes back is exact. The knowledge index is never consulted
for a figure; a vector search that "remembers" a pipeline total is a bug waiting to be shipped.

Every function takes the actor and returns two things:

``facts``
    Short deterministic sentences. These are the evidence the model is given and, when no model is
    available, they are the answer.
``sections``
    The same information as typed items the dashboard renders directly: records, events and metrics,
    each already resolved to something the caller may open.

Nothing here calls a model, so every function keeps working with AI switched off, unconfigured or
down.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from django.db.models import Q, QuerySet
from django.utils import timezone

from apps.ai import nba, risk
from apps.authz.actor import Actor
from apps.authz.service import scope

MAX_RECORDS = 8
MAX_EVENTS = 12
STALE_DAYS = 14


@dataclass
class Section:
    title: str
    kind: str  # records | events | metrics
    items: list[dict[str, Any]] = field(default_factory=list)
    hint: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"title": self.title, "kind": self.kind, "items": self.items, "hint": self.hint}


@dataclass
class ToolResult:
    answer_type: str = "answer"
    headline: str = ""
    facts: list[str] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)
    recommendation: str = ""
    # Records this answer is about, so retrieval can be narrowed to them.
    focus: list[tuple[str, uuid.UUID]] = field(default_factory=list)

    def add(self, section: Section) -> None:
        if section.items:
            self.sections.append(section)


# --------------------------------------------------------------------------- helpers


def _money(amount: Any) -> str:
    return str((amount if amount is not None else Decimal("0")).quantize(Decimal("0.01")))


def _deals(actor: Actor) -> QuerySet | None:
    from apps.deals.models import Deal

    if not actor.has("deals.view"):
        return None
    return scope(actor, "deals.view", Deal.objects.filter(archived_at__isnull=True))


def _activities(actor: Actor) -> QuerySet | None:
    from apps.activities.models import Activity

    if not actor.has("activities.view"):
        return None
    return scope(actor, "activities.view", Activity.objects.all())


def _days(since: dt.datetime | None, now: dt.datetime) -> int | None:
    return None if since is None else max(0, (now - since).days)


def deal_item(deal: Any, *, meta: str = "") -> dict[str, Any]:
    return {
        "id": str(deal.pk),
        "type": "deal",
        "title": deal.name,
        "subtitle": deal.stage.name if deal.stage_id else "",
        "meta": meta,
        "amount": _money(deal.amount),
        "currency": deal.currency,
        "href": f"/deals/{deal.pk}",
    }


def record_item(entity_type: str, obj: Any, *, meta: str = "") -> dict[str, Any]:
    if entity_type == "deal":
        return deal_item(obj, meta=meta)
    if entity_type == "contact":
        return {
            "id": str(obj.pk),
            "type": "contact",
            "title": obj.display_name,
            "subtitle": obj.job_title or obj.email,
            "meta": meta or (obj.company.name if obj.company_id else ""),
            "href": f"/contacts/{obj.pk}",
        }
    return {
        "id": str(obj.pk),
        "type": entity_type,
        "title": getattr(obj, "name", ""),
        "subtitle": getattr(obj, "industry", "") or getattr(obj, "website", ""),
        "meta": meta,
        "href": f"/{'companies' if entity_type == 'company' else entity_type + 's'}/{obj.pk}",
    }


def activity_item(activity: Any) -> dict[str, Any]:
    when = activity.start_at or activity.completed_at or activity.created_at
    return {
        "id": str(activity.pk),
        "type": "activity",
        "label": activity.get_kind_display(),
        "title": activity.title,
        "subtitle": activity.get_status_display(),
        "occurred_at": when.isoformat() if when else None,
        "href": f"/activities?activity={activity.pk}",
    }


# --------------------------------------------------------------------------- entity resolution


def resolve_records(actor: Actor, hints: list[str], *, limit: int = 2) -> list[tuple[str, Any]]:
    """Turn names mentioned in a question into real records the caller may open.

    Reuses global search, so resolution is subject to exactly the same tenant and permission scoping
    as typing the name into Cmd+K. A hint that resolves to nothing simply yields nothing.
    """
    from apps.search import service as search_service

    found: list[tuple[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for hint in hints:
        results = search_service.search(actor, hint, types=["company", "contact", "deal"], per_type=2)["results"]
        for entity_type in ("company", "deal", "contact"):
            for row in results.get(entity_type, []):
                key = (entity_type, row["id"])
                if key in seen:
                    continue
                obj = _load(actor, entity_type, uuid.UUID(row["id"]))
                if obj is None:
                    continue
                seen.add(key)
                found.append((entity_type, obj))
                break
            if len(found) >= limit:
                return found[:limit]
    return found[:limit]


def _load(actor: Actor, entity_type: str, pk: uuid.UUID) -> Any:
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal

    model, permission, related = {
        "company": (Company, "companies.view", ()),
        "contact": (Contact, "contacts.view", ("company",)),
        "deal": (Deal, "deals.view", ("stage", "company", "primary_contact", "owner__user")),
    }[entity_type]
    queryset = model.objects.filter(pk=pk, archived_at__isnull=True)
    if related:
        queryset = queryset.select_related(*related)
    return scope(actor, permission, queryset).first()


# --------------------------------------------------------------------------- tools


def entity_snapshot(actor: Actor, entity_type: str, record: Any) -> ToolResult:
    """Everything structured about one customer: who they are, their open deals, what is scheduled."""
    now = timezone.now()
    result = ToolResult(answer_type="summary", headline=_title(entity_type, record))
    result.focus.append((entity_type, record.pk))
    result.facts.append(f"{_title(entity_type, record)} is a {entity_type} in the CRM.")

    deals = _related_deals(actor, entity_type, record)
    if deals:
        open_deals = [d for d in deals if d.status == "open"]
        section = Section(title="Deals", kind="records")
        for deal in deals[:MAX_RECORDS]:
            idle = _days(deal.last_activity_at, now)
            meta = f"{deal.probability}% · {'no activity for ' + str(idle) + ' days' if idle else 'active'}"
            section.items.append(deal_item(deal, meta=meta))
            result.focus.append(("deal", deal.pk))
        result.add(section)
        for deal in open_deals[:3]:
            result.facts.append(
                f"Open deal '{deal.name}': {deal.amount} {deal.currency}, stage "
                f"{deal.stage.name if deal.stage_id else 'unknown'}, probability {deal.probability}%"
                + (f", expected close {deal.expected_close_date.isoformat()}" if deal.expected_close_date else "")
                + "."
            )
            days_in_stage = _days(deal.stage_entered_at, now)
            if days_in_stage is not None:
                result.facts.append(f"'{deal.name}' has been in that stage for {days_in_stage} days.")
            idle = _days(deal.last_activity_at or deal.stage_entered_at, now)
            if idle is not None:
                result.facts.append(f"Last recorded activity on '{deal.name}' was {idle} days ago.")
            if deal.next_activity_at is None and deal.status == "open":
                result.facts.append(f"No next activity is scheduled on '{deal.name}'.")
        if not open_deals:
            result.facts.append("There are no open deals for this record.")
    else:
        result.facts.append("No deals are linked to this record.")

    events = recent_events(actor, entity_type, record)
    if events:
        result.add(Section(title="Recent activity", kind="events", items=events))
        result.facts.append(f"{len(events)} recent interactions are recorded (see the timeline).")

    if deals:
        open_deals = [d for d in deals if d.status == "open"]
        if open_deals:
            recommendation = nba.recommend(open_deals[0], now=now)
            if recommendation is not None:
                result.recommendation = f"{recommendation.action}. {recommendation.reason}"
    return result


def _title(entity_type: str, record: Any) -> str:
    return record.display_name if entity_type == "contact" else record.name


def _related_deals(actor: Actor, entity_type: str, record: Any) -> list[Any]:
    deals = _deals(actor)
    if deals is None:
        return []
    if entity_type == "deal":
        return [record]
    if entity_type == "company":
        predicate = Q(company_id=record.pk)
    else:
        predicate = Q(primary_contact_id=record.pk) | Q(deal_contacts__contact_id=record.pk)
    return list(
        deals.filter(predicate)
        .select_related("stage", "company")
        .distinct()
        .order_by("-status", "-amount_base")[:MAX_RECORDS]
    )


def recent_events(actor: Actor, entity_type: str, record: Any, *, limit: int = MAX_EVENTS) -> list[dict[str, Any]]:
    """Recent interactions the caller may see: activities, emails, WhatsApp. Newest first.

    Deliberately mirrors ``apps.ai.context.timeline_blocks`` -- same permissions, same sources -- so
    what the assistant can cite is exactly what the record timeline already shows the caller.
    """

    rows: list[tuple[dt.datetime, dict[str, Any]]] = []
    link = _link_filter(entity_type, record)
    if link is None:
        return []

    activities = _activities(actor)
    if activities is not None:
        for activity in activities.filter(**link).order_by("-created_at")[:limit]:
            when = activity.completed_at or activity.start_at or activity.created_at
            rows.append(
                (
                    when,
                    {
                        **activity_item(activity),
                        "snippet": (activity.description or "")[:200],
                        "occurred_at": when.isoformat() if when else None,
                    },
                )
            )

    from apps.messaging.models import EmailMessage, WhatsAppMessage

    if actor.has("email.view"):
        for message in EmailMessage.objects.filter(**link).order_by("-created_at")[:limit]:
            when = message.sent_at or message.received_at or message.created_at
            rows.append(
                (
                    when,
                    {
                        "id": str(message.pk),
                        "type": "email",
                        "label": "Email",
                        "title": message.subject or f"{message.direction.title()} email",
                        "subtitle": message.direction,
                        "snippet": (message.snippet or message.body_text or "")[:200],
                        "occurred_at": when.isoformat() if when else None,
                        "href": _record_href(entity_type, record.pk),
                    },
                )
            )
    if actor.has("whatsapp.view"):
        for chat in WhatsAppMessage.objects.filter(**link).order_by("-created_at")[:limit]:
            when = chat.sent_at or chat.received_at or chat.created_at
            rows.append(
                (
                    when,
                    {
                        "id": str(chat.pk),
                        "type": "whatsapp",
                        "label": "WhatsApp",
                        "title": f"{chat.direction.title()} message",
                        "subtitle": chat.direction,
                        "snippet": (chat.body or "")[:200],
                        "occurred_at": when.isoformat() if when else None,
                        "href": f"/contacts/{chat.contact_id}" if chat.contact_id else "",
                    },
                )
            )

    rows.sort(key=lambda row: row[0] or timezone.now(), reverse=True)
    return [item for _, item in rows[:limit]]


def _record_href(entity_type: str, pk: Any) -> str:
    path = {"contact": "contacts", "company": "companies", "deal": "deals"}.get(entity_type, "")
    return f"/{path}/{pk}" if path else ""


def _link_filter(entity_type: str, record: Any) -> dict[str, Any] | None:
    if entity_type in {"contact", "company", "deal"}:
        return {entity_type: record}
    return None


def pipeline_summary(actor: Actor, *, period: str = "30d", pipeline_id: uuid.UUID | None = None) -> ToolResult:
    """The dashboard numbers, reused rather than recomputed (same cache, same permission scoping)."""
    from apps.dashboards import service as dashboards

    data = dashboards.summary(actor, period=period, pipeline_id=pipeline_id)
    currency = data["currency"]
    result = ToolResult(answer_type="forecast" if pipeline_id else "crm_results", headline="Pipeline")
    if data.get("open_pipeline") is None:
        result.facts.append("Your role does not include access to deals, so pipeline figures are unavailable.")
        return result

    metrics = Section(title="Pipeline", kind="metrics")
    for label, key, hint in (
        ("Open pipeline", "open_pipeline", "Right now"),
        ("Weighted pipeline", "weighted_pipeline", "Value x probability"),
        ("Won", "deals_won", "In the period"),
        ("Lost", "deals_lost", "In the period"),
    ):
        row = data.get(key) or {}
        metrics.items.append(
            {
                "label": label,
                "amount": row.get("amount"),
                "currency": currency,
                "count": row.get("count"),
                "hint": hint,
            }
        )
    result.add(metrics)
    open_row = data["open_pipeline"]
    weighted = data["weighted_pipeline"]
    result.facts.append(
        f"Open pipeline: {open_row['count']} deals worth {open_row['amount']} {currency}; "
        f"weighted by probability that is {weighted['amount']} {currency}."
    )
    won = data["deals_won"]
    result.facts.append(f"Won in the last {period}: {won['count']} deals worth {won['amount']} {currency}.")
    if data.get("win_rate") is not None:
        result.facts.append(f"Win rate over the period: {data['win_rate']}%.")
    if data.get("average_deal_size"):
        result.facts.append(f"Average won deal size: {data['average_deal_size']} {currency}.")

    stages = (data.get("deals_by_stage") or {}).get("stages") or []
    if stages:
        result.add(
            Section(
                title="By stage",
                kind="metrics",
                items=[
                    {"label": s["name"], "amount": s["amount"], "currency": currency, "count": s["count"]}
                    for s in stages
                ],
            )
        )
        biggest = max(stages, key=lambda s: s["count"])
        result.facts.append(f"Most open deals sit in '{biggest['name']}' ({biggest['count']} deals).")
    return result


def forecast_summary(actor: Actor) -> ToolResult:
    from apps.dashboards import service as dashboards

    data = dashboards.summary(actor)
    result = ToolResult(answer_type="forecast", headline="Forecast")
    rows = data.get("forecast")
    if rows is None:
        result.facts.append("Your role does not include access to deals, so the forecast is unavailable.")
        return result
    currency = data["currency"]
    result.add(
        Section(
            title="Next 3 months by expected close",
            kind="metrics",
            items=[
                {
                    "label": row["month"],
                    "amount": row["weighted"],
                    "currency": currency,
                    "count": row["count"],
                    "hint": f"{row['amount']} {currency} unweighted",
                }
                for row in rows
            ],
        )
    )
    for row in rows:
        result.facts.append(
            f"{row['month']}: {row['count']} deals, {row['amount']} {currency} open, "
            f"{row['weighted']} {currency} weighted."
        )
    return result


def deals_needing_attention(actor: Actor, *, limit: int = MAX_RECORDS) -> ToolResult:
    """Open deals ranked by the rules-based risk score. No model, no prediction, no black box."""
    now = timezone.now()
    result = ToolResult(answer_type="deal_risk", headline="Deals that need attention")
    deals = _deals(actor)
    if deals is None:
        result.facts.append("Your role does not include access to deals.")
        return result

    candidates = list(
        deals.filter(status="open").select_related("stage", "company").order_by("-amount_base")[: limit * 6]
    )
    assessed = [(risk.assess_deal(deal, now=now), deal) for deal in candidates]
    assessed = [pair for pair in assessed if pair[0].score > 0]
    assessed.sort(key=lambda pair: (pair[0].score, pair[1].amount_base), reverse=True)

    section = Section(title="At risk", kind="records", hint="Rules-based risk, highest first")
    for assessment, deal in assessed[:limit]:
        section.items.append(
            deal_item(deal, meta=f"{assessment.level.title()} risk · {'; '.join(assessment.reasons[:2])}")
        )
        result.focus.append(("deal", deal.pk))
        result.facts.append(
            f"'{deal.name}' ({deal.amount} {deal.currency}, {deal.stage.name if deal.stage_id else 'no stage'}) "
            f"scores {assessment.level} risk: {' '.join(assessment.reasons[:3])}"
        )
    result.add(section)
    if not assessed:
        result.facts.append("No open deal currently trips a risk rule.")
    elif assessed[0][0].recommended_action:
        result.recommendation = assessed[0][0].recommended_action
    return result


def deal_risk_detail(actor: Actor, deal: Any) -> ToolResult:
    """The full rules-based picture for one deal: risk signals, next best action, lead score."""
    from apps.ai import insights

    data = insights.deal_insights(actor, deal)
    result = ToolResult(answer_type="deal_risk", headline=deal.name)
    result.focus.append(("deal", deal.pk))
    assessment = data["risk"]
    result.facts.append(
        f"'{deal.name}': {deal.amount} {deal.currency}, stage "
        f"{deal.stage.name if deal.stage_id else 'unknown'}, probability {deal.probability}%, status {deal.status}."
    )
    result.facts.append(f"Rules-based risk: {assessment['level']} (score {assessment['score']}/100).")
    result.facts.extend(assessment["reasons"])
    recommendation = data.get("next_best_action")
    if recommendation:
        result.recommendation = f"{recommendation['action']}. {recommendation['reason']}"
    result.add(
        Section(
            title="Risk signals",
            kind="metrics",
            items=[
                {"label": signal.get("signal", "").replace("_", " ").title(), "count": signal.get("days"), "hint": ""}
                for signal in assessment.get("signals", [])
            ],
            hint="Rules-based, not a prediction",
        )
    )
    events = recent_events(actor, "deal", deal, limit=6)
    if events:
        result.add(Section(title="Recent activity", kind="events", items=events))
    return result


def my_day(actor: Actor) -> ToolResult:
    """What this member should do today: overdue work first, then what is scheduled, then what is
    slipping. Only their own records -- own/team/all scopes apply exactly as everywhere else."""
    now = timezone.now()
    today_end = now.replace(hour=23, minute=59, second=59, microsecond=0)
    result = ToolResult(answer_type="next_action", headline="Your day")

    activities = _activities(actor)
    if activities is not None:
        mine = activities.filter(owner=actor.membership, status__in=("open", "in_progress"))
        overdue = list(mine.filter(start_at__lt=now).order_by("start_at")[:MAX_RECORDS])
        today = list(mine.filter(start_at__gte=now, start_at__lte=today_end).order_by("start_at")[:MAX_RECORDS])
        if overdue:
            result.add(Section(title="Overdue", kind="events", items=[activity_item(a) for a in overdue]))
            result.facts.append(f"{len(overdue)} of your activities are overdue.")
            for activity in overdue[:3]:
                result.facts.append(
                    f"Overdue {activity.kind}: '{activity.title}'"
                    + (f" (due {activity.start_at.strftime('%d %b')})" if activity.start_at else "")
                    + "."
                )
        if today:
            result.add(Section(title="Today", kind="events", items=[activity_item(a) for a in today]))
            result.facts.append(f"{len(today)} activities are scheduled for the rest of today.")
            for activity in today[:4]:
                result.facts.append(
                    f"{activity.get_kind_display()} '{activity.title}' at "
                    f"{activity.start_at.strftime('%H:%M') if activity.start_at else 'no time set'}."
                )
        if not overdue and not today:
            result.facts.append("Nothing is overdue and nothing is scheduled for the rest of today.")
    else:
        result.facts.append("Your role does not include access to activities.")

    deals = _deals(actor)
    if deals is not None:
        stale_before = now - dt.timedelta(days=STALE_DAYS)
        stale = list(
            deals.filter(status="open", owner=actor.membership)
            .filter(Q(last_activity_at__lt=stale_before) | Q(last_activity_at__isnull=True))
            .filter(next_activity_at__isnull=True)
            .select_related("stage", "company")
            .order_by("-amount_base")[:MAX_RECORDS]
        )
        if stale:
            result.add(
                Section(
                    title="Going quiet",
                    kind="records",
                    hint=f"No activity for {STALE_DAYS}+ days and nothing scheduled",
                    items=[deal_item(deal, meta="No next step scheduled") for deal in stale],
                )
            )
            result.facts.append(f"{len(stale)} of your open deals have gone quiet with no next step booked.")
            for deal in stale[:3]:
                result.focus.append(("deal", deal.pk))
                result.facts.append(f"'{deal.name}' ({deal.amount} {deal.currency}) has no scheduled next step.")
            result.recommendation = f"Book a next step on '{stale[0].name}' before it slips further."
    return result


def deal_list(
    actor: Actor,
    *,
    time_window: str = "",
    min_amount: float | None = None,
    won: bool = False,
    limit: int = MAX_RECORDS,
) -> ToolResult:
    """Filtered deal lists: closing this week, above an amount, won this month."""
    now = timezone.now()
    result = ToolResult(answer_type="crm_results", headline="Deals")
    deals = _deals(actor)
    if deals is None:
        result.facts.append("Your role does not include access to deals.")
        return result

    queryset = deals.select_related("stage", "company")
    described: list[str] = []
    if won:
        queryset = queryset.filter(status="won")
        described.append("won")
    else:
        queryset = queryset.filter(status="open")
        described.append("open")

    start, end = _window_bounds(time_window, now)
    if start is not None and end is not None:
        field = "closed_at" if won else "expected_close_date"
        if won:
            queryset = queryset.filter(closed_at__gte=start, closed_at__lt=end)
        else:
            queryset = queryset.filter(expected_close_date__gte=start.date(), expected_close_date__lt=end.date())
        described.append(f"{field.replace('_', ' ')} between {start.date()} and {end.date()}")
    if min_amount is not None:
        queryset = queryset.filter(amount_base__gte=Decimal(str(min_amount)))
        described.append(f"worth at least {min_amount:,.0f}")

    rows = list(queryset.order_by("-amount_base")[:limit])
    total = sum((deal.amount_base or Decimal("0") for deal in rows), Decimal("0"))
    result.add(
        Section(
            title="Matching deals",
            kind="records",
            hint=", ".join(described),
            items=[
                deal_item(
                    deal,
                    meta=deal.expected_close_date.strftime("%d %b %Y") if deal.expected_close_date else "",
                )
                for deal in rows
            ],
        )
    )
    for deal in rows:
        result.focus.append(("deal", deal.pk))
    currency = actor.organization.base_currency
    result.facts.append(
        f"{len(rows)} {' '.join(described)} deals found, {_money(total)} {currency} in total"
        + (" (showing the largest)" if len(rows) == limit else "")
        + "."
    )
    for deal in rows[:5]:
        result.facts.append(
            f"'{deal.name}': {deal.amount} {deal.currency}, {deal.stage.name if deal.stage_id else 'no stage'}"
            + (f", expected {deal.expected_close_date.isoformat()}" if deal.expected_close_date else "")
            + "."
        )
    if not rows:
        result.facts.append("No deals match that filter.")
    return result


def activity_list(actor: Actor, *, time_window: str = "today", limit: int = MAX_RECORDS) -> ToolResult:
    now = timezone.now()
    result = ToolResult(answer_type="timeline", headline="Activities")
    activities = _activities(actor)
    if activities is None:
        result.facts.append("Your role does not include access to activities.")
        return result

    queryset = activities.filter(owner=actor.membership)
    if time_window == "overdue":
        queryset = queryset.filter(status__in=("open", "in_progress"), start_at__lt=now)
        label = "overdue"
    else:
        start, end = _window_bounds(time_window or "today", now)
        queryset = queryset.filter(start_at__gte=start, start_at__lt=end)
        label = (time_window or "today").replace("_", " ")
    rows = list(queryset.order_by("start_at")[:limit])
    result.add(Section(title=label.title(), kind="events", items=[activity_item(a) for a in rows]))
    result.facts.append(f"{len(rows)} activities {label}.")
    for activity in rows[:6]:
        result.facts.append(
            f"{activity.get_kind_display()} '{activity.title}'"
            + (f" at {activity.start_at.strftime('%d %b %H:%M')}" if activity.start_at else "")
            + f" ({activity.get_status_display()})."
        )
    return result


def quiet_customers(actor: Actor, *, limit: int = MAX_RECORDS) -> ToolResult:
    """Open deals where we spoke last and nobody answered."""
    now = timezone.now()
    result = ToolResult(answer_type="crm_results", headline="Waiting on a reply")
    deals = _deals(actor)
    if deals is None:
        result.facts.append("Your role does not include access to deals.")
        return result
    cutoff = now - dt.timedelta(days=5)
    rows = list(
        deals.filter(status="open", last_activity_at__lt=cutoff)
        .select_related("stage", "company")
        .order_by("last_activity_at")[:limit]
    )
    section = Section(title="No recent response", kind="records", hint="Quiet for 5+ days")
    for deal in rows:
        idle = _days(deal.last_activity_at, now)
        section.items.append(deal_item(deal, meta=f"{idle} days quiet" if idle is not None else ""))
        result.focus.append(("deal", deal.pk))
        result.facts.append(f"'{deal.name}' has had no recorded activity for {idle} days.")
    result.add(section)
    if not rows:
        result.facts.append("Every open deal has had activity in the last 5 days.")
    return result


def _window_bounds(window: str, now: dt.datetime) -> tuple[dt.datetime | None, dt.datetime | None]:
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "today":
        return start_of_day, start_of_day + dt.timedelta(days=1)
    if window == "this_week":
        start = start_of_day - dt.timedelta(days=start_of_day.weekday())
        return start, start + dt.timedelta(days=7)
    if window == "next_week":
        start = start_of_day - dt.timedelta(days=start_of_day.weekday()) + dt.timedelta(days=7)
        return start, start + dt.timedelta(days=7)
    if window == "this_month":
        start = start_of_day.replace(day=1)
        return start, _add_month(start)
    if window == "last_month":
        start = _sub_month(start_of_day.replace(day=1))
        return start, start_of_day.replace(day=1)
    if window == "this_quarter":
        start = start_of_day.replace(month=((now.month - 1) // 3) * 3 + 1, day=1)
        return start, _add_month(_add_month(_add_month(start)))
    return None, None


def _add_month(value: dt.datetime) -> dt.datetime:
    return value.replace(year=value.year + 1, month=1) if value.month == 12 else value.replace(month=value.month + 1)


def _sub_month(value: dt.datetime) -> dt.datetime:
    return value.replace(year=value.year - 1, month=12) if value.month == 1 else value.replace(month=value.month - 1)
