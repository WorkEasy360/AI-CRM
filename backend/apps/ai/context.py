"""Context packs for the LLM: permitted, structured, delimited, size-capped.

Authorization happens *before* anything is collected: callers resolve the record inside the actor's
view scope, and every related row is loaded through ``authz.scope`` (activities, notes, messages).
Structured fields are rendered as attributes; free text always goes through ``safety.crm_block``.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

from apps.ai import safety
from apps.authz.actor import Actor
from apps.authz.service import scope

MAX_TIMELINE_ITEMS = 25
MAX_CONTEXT_CHARS = 24_000


@dataclass
class ContextPack:
    text: str
    flagged: bool = False
    sources: list[str] = field(default_factory=list)
    latest_event_at: dt.datetime | None = None


def _fmt_dt(value: dt.datetime | dt.date | None) -> str:
    if value is None:
        return ""
    if isinstance(value, dt.datetime):
        return value.astimezone(dt.UTC).strftime("%Y-%m-%d %H:%M")
    return value.isoformat()


def _money(amount: Any, currency: str) -> str:
    return f"{amount} {currency}".strip()


def deal_facts(deal: Any) -> str:
    stage = getattr(deal, "stage", None)
    company = deal.company.name if deal.company_id and deal.company else ""
    contact = deal.primary_contact.display_name if deal.primary_contact_id and deal.primary_contact else ""
    owner = deal.owner.user.display_name if deal.owner_id and deal.owner else ""
    return (
        f'<deal id="{deal.pk}" name="{safety.escape(deal.name)}" status="{deal.status}" '
        f'stage="{safety.escape(getattr(stage, "name", ""))}" probability="{deal.probability}%" '
        f'value="{safety.escape(_money(deal.amount, deal.currency))}" '
        f'expected_close="{_fmt_dt(deal.expected_close_date)}" stage_since="{_fmt_dt(deal.stage_entered_at)}" '
        f'last_activity="{_fmt_dt(deal.last_activity_at)}" next_activity="{_fmt_dt(deal.next_activity_at)}" '
        f'company="{safety.escape(company)}" contact="{safety.escape(contact)}" owner="{safety.escape(owner)}" />'
    )


def contact_facts(contact: Any) -> str:
    company = contact.company if contact.company_id and contact.company else None
    return (
        f'<contact id="{contact.pk}" name="{safety.escape(contact.display_name)}" '
        f'title="{safety.escape(contact.job_title)}" '
        f'company="{safety.escape(company.name if company else "")}" lifecycle="{contact.lifecycle_stage}" '
        f'last_activity="{_fmt_dt(contact.last_activity_at)}" next_activity="{_fmt_dt(contact.next_activity_at)}" />'
    )


def company_facts(company: Any) -> str:
    return (
        f'<company id="{company.pk}" name="{safety.escape(company.name)}" industry="{safety.escape(company.industry)}" '
        f'size="{safety.escape(company.company_size)}" lifecycle="{company.lifecycle_stage}" />'
    )


def timeline_blocks(
    actor: Actor, entity_type: str, record: Any, *, limit: int = MAX_TIMELINE_ITEMS
) -> tuple[list[str], bool, dt.datetime | None]:
    """Recent notes, activities, emails and WhatsApp messages the actor may see, newest first."""
    from apps.activities.models import Activity
    from apps.notes.models import Note

    items: list[tuple[dt.datetime, str, bool]] = []
    for note in Note.objects.filter(entity_type=entity_type, entity_id=record.pk).order_by("-created_at")[:limit]:
        block = safety.crm_block("note", note.body, record_id=str(note.pk), extra={"at": _fmt_dt(note.created_at)})
        items.append((note.created_at, block, 'untrusted="high"' in block))
    activities = scope(actor, "activities.view", Activity.objects.filter(**{entity_type: record})).order_by(
        "-created_at"
    )[:limit]
    for a in activities:
        when = a.completed_at or a.start_at or a.created_at
        summary = f"{a.get_kind_display()} '{a.title}' ({a.get_status_display()}"
        if a.outcome:
            summary += f", outcome {a.get_outcome_display()}"
        if a.direction:
            summary += f", {a.direction}"
        summary += f", {_fmt_dt(when)})"
        text = summary + (f": {a.description}" if a.description else "")
        block = safety.crm_block("activity", text, record_id=str(a.pk), extra={"at": _fmt_dt(when)})
        items.append((when, block, 'untrusted="high"' in block))
    from apps.messaging.models import EmailMessage, WhatsAppMessage

    if actor.has("email.view"):
        for m in EmailMessage.objects.filter(**{entity_type: record}).order_by("-created_at")[:limit]:
            when = m.sent_at or m.received_at or m.created_at
            text = f"{m.direction} email, subject: {m.subject}\n{m.body_text[:1500]}"
            block = safety.crm_block(
                "email", text, record_id=str(m.pk), extra={"at": _fmt_dt(when), "direction": m.direction}
            )
            items.append((when, block, 'untrusted="high"' in block))
    if actor.has("whatsapp.view"):
        for w in WhatsAppMessage.objects.filter(**{entity_type: record}).order_by("-created_at")[:limit]:
            when = w.sent_at or w.received_at or w.created_at
            block = safety.crm_block(
                "whatsapp",
                f"{w.direction}: {w.body}",
                record_id=str(w.pk),
                extra={"at": _fmt_dt(when), "direction": w.direction},
            )
            items.append((when, block, 'untrusted="high"' in block))
    items.sort(key=lambda x: x[0], reverse=True)
    items = items[:limit]
    blocks = [b for _, b, _ in items if b]
    flagged = any(f for _, _, f in items)
    latest = items[0][0] if items else None
    return blocks, flagged, latest


def build_deal_context(actor: Actor, deal: Any) -> ContextPack:
    parts = [deal_facts(deal)]
    sources = ["deal"]
    if deal.company_id and deal.company:
        parts.append(company_facts(deal.company))
        sources.append("company")
    if deal.primary_contact_id and deal.primary_contact:
        parts.append(contact_facts(deal.primary_contact))
        sources.append("contact")
    blocks, flagged, latest = timeline_blocks(actor, "deal", deal)
    if blocks:
        parts.append('<timeline newest_first="true">' + "\n".join(blocks) + "</timeline>")
        sources.append("timeline")
    text = "\n".join(parts)
    if len(text) > MAX_CONTEXT_CHARS:
        text = text[:MAX_CONTEXT_CHARS] + "\n[context truncated]"
    return ContextPack(text=text, flagged=flagged, sources=sources, latest_event_at=latest)


def build_contact_context(actor: Actor, contact: Any, *, deal: Any = None) -> ContextPack:
    parts = [contact_facts(contact)]
    sources = ["contact"]
    if contact.company_id and contact.company:
        parts.append(company_facts(contact.company))
        sources.append("company")
    if deal is not None:
        parts.append(deal_facts(deal))
        sources.append("deal")
    blocks, flagged, latest = timeline_blocks(actor, "contact", contact)
    if blocks:
        parts.append('<timeline newest_first="true">' + "\n".join(blocks) + "</timeline>")
        sources.append("timeline")
    text = "\n".join(parts)
    if len(text) > MAX_CONTEXT_CHARS:
        text = text[:MAX_CONTEXT_CHARS] + "\n[context truncated]"
    return ContextPack(text=text, flagged=flagged, sources=sources, latest_event_at=latest)
