"""Rules-based lead score (0-100) for contacts, with the reasons that produced it.

Honest labelling: this is a *rules-based* score. It stays labelled that way until a trained,
evaluated model exists (see docs/architecture/ai-architecture.md, "Scoring").
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

from django.utils import timezone

LABEL = "Rules-based score"


@dataclass
class ContactFacts:
    lifecycle_stage: str = "lead"
    has_email: bool = False
    has_phone: bool = False
    has_company: bool = False
    has_job_title: bool = False
    source: str = ""
    open_deal_count: int = 0
    last_activity_at: dt.datetime | None = None
    next_activity_at: dt.datetime | None = None
    created_at: dt.datetime | None = None
    # Engagement counts (last 30 days); None when the caller did not load them (list rows).
    meetings_30d: int | None = None
    calls_connected_30d: int | None = None
    emails_replied_30d: int | None = None
    whatsapp_replies_30d: int | None = None
    company_size: str = ""
    won_deals: int = 0


@dataclass
class LeadScore:
    value: int
    label: str = LABEL
    reasons: list[str] = field(default_factory=list)
    factors: list[dict[str, Any]] = field(default_factory=list)


BIG_COMPANY_SIZES = {"201-500", "501-1000", "1001-5000", "5000+"}


def score_contact(f: ContactFacts, *, now: dt.datetime | None = None) -> LeadScore:
    now = now or timezone.now()
    points = 20
    factors: list[dict[str, Any]] = []

    def add(delta: int, reason: str, key: str) -> None:
        nonlocal points
        points += delta
        factors.append({"key": key, "points": delta, "reason": reason})

    stage_points = {"lead": 0, "prospect": 8, "qualified": 18, "customer": 25, "inactive": -20}
    delta = stage_points.get(f.lifecycle_stage, 0)
    if delta:
        add(delta, f"Lifecycle stage: {f.lifecycle_stage}", "lifecycle")

    completeness = sum([f.has_email, f.has_phone, f.has_company, f.has_job_title])
    if completeness >= 3:
        add(8, "Complete profile (email, phone, company, title)", "profile")
    elif completeness <= 1:
        add(-5, "Profile is mostly empty", "profile")

    if f.company_size in BIG_COMPANY_SIZES:
        add(6, "Works at a larger company", "company_fit")

    if f.open_deal_count > 0:
        add(12, f"{f.open_deal_count} open deal{'s' if f.open_deal_count != 1 else ''}", "deals")
    if f.won_deals > 0:
        add(6, "Has bought before", "won_deals")

    if f.last_activity_at is not None:
        idle = (now - f.last_activity_at).days
        if idle <= 3:
            add(15, "Activity in the last 3 days", "recency")
        elif idle <= 7:
            add(10, "Activity in the last week", "recency")
        elif idle <= 30:
            add(3, "Activity in the last month", "recency")
        elif idle > 60:
            add(-10, f"No activity for {idle} days", "recency")
    elif f.created_at is not None and (now - f.created_at).days > 14:
        add(-8, "Never contacted", "recency")

    if f.next_activity_at is not None and f.next_activity_at >= now:
        add(8, "Next activity scheduled", "next_step")

    if f.meetings_30d:
        add(min(15, 8 + 4 * (f.meetings_30d - 1)), f"{f.meetings_30d} meeting(s) in the last 30 days", "meetings")
    if f.calls_connected_30d:
        add(min(10, 5 + 3 * (f.calls_connected_30d - 1)), f"{f.calls_connected_30d} connected call(s)", "calls")
    if f.emails_replied_30d:
        add(min(12, 8 + 2 * (f.emails_replied_30d - 1)), "Replied to email", "email")
    if f.whatsapp_replies_30d:
        add(min(10, 6 + 2 * (f.whatsapp_replies_30d - 1)), "Replied on WhatsApp", "whatsapp")

    source = (f.source or "").strip().lower()
    if source in {"referral", "partner", "customer referral"}:
        add(8, f"Source: {f.source}", "source")
    elif source in {"inbound", "website", "demo request", "trial"}:
        add(5, f"Source: {f.source}", "source")

    value = max(0, min(100, points))
    reasons = [x["reason"] for x in sorted(factors, key=lambda x: -abs(x["points"]))[:6]]
    return LeadScore(value=value, reasons=reasons, factors=factors)


def facts_from_row(contact: Any) -> ContactFacts:
    """Facts available on a serialized contact row (no extra queries)."""
    company = getattr(contact, "company", None) if getattr(contact, "company_id", None) else None
    return ContactFacts(
        lifecycle_stage=contact.lifecycle_stage,
        has_email=bool(contact.email),
        has_phone=bool(contact.phone),
        has_company=bool(contact.company_id),
        has_job_title=bool(contact.job_title),
        source=contact.source,
        open_deal_count=int(getattr(contact, "open_deal_count", 0) or 0),
        last_activity_at=contact.last_activity_at,
        next_activity_at=contact.next_activity_at,
        created_at=contact.created_at,
        company_size=getattr(company, "company_size", "") if company is not None else "",
    )


def score_contact_row(contact: Any) -> int:
    return score_contact(facts_from_row(contact)).value


def facts_with_engagement(contact: Any, *, now: dt.datetime | None = None) -> ContactFacts:
    """Full facts for the detail endpoint: adds 30-day engagement counts (four small COUNTs)."""
    from django.db.models import Count, Q

    from apps.activities.models import Activity

    now = now or timezone.now()
    since = now - dt.timedelta(days=30)
    facts = facts_from_row(contact)
    agg = Activity.objects.filter(contact=contact, status="completed", completed_at__gte=since).aggregate(
        meetings=Count("id", filter=Q(kind="meeting")),
        calls=Count("id", filter=Q(kind="call", outcome__in=["connected", "interested", "follow_up_required"])),
    )
    facts.meetings_30d = agg["meetings"]
    facts.calls_connected_30d = agg["calls"]
    try:
        from apps.messaging.models import EmailMessage, WhatsAppMessage

        facts.emails_replied_30d = EmailMessage.objects.filter(
            contact=contact, direction="inbound", received_at__gte=since
        ).count()
        facts.whatsapp_replies_30d = WhatsAppMessage.objects.filter(
            contact=contact, direction="inbound", received_at__gte=since
        ).count()
    except Exception:  # messaging not installed in a minimal deployment
        facts.emails_replied_30d = 0
        facts.whatsapp_replies_30d = 0
    from apps.deals.models import Deal

    facts.won_deals = Deal.objects.filter(primary_contact=contact, status="won").count()
    return facts
