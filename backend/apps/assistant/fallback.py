"""Deterministic answers, written by the server.

This is what Ask Keel says when no model answers -- provider outage, exhausted budget, or AI switched
off for the workspace. It is not an error message. "AI is unavailable" tells a salesperson nothing;
"ABC Corp, one open deal worth 850,000 in Proposal, last contact 9 days ago, here are the four most
recent interactions" answers most of what they actually wanted to know.

No language model is involved, which is the point: templates are cheap, instant, always available,
and cannot hallucinate. The retrieved evidence appears as quoted excerpts attributed to their source
rather than as prose, because only a model can responsibly turn evidence into narrative -- and when
there is no model, we show the evidence instead of imitating one.
"""

from __future__ import annotations

from typing import Any

from apps.assistant import intent as intent_module
from apps.assistant.crm_tools import Section, ToolResult

MODE_RETRIEVAL = "retrieval"
MAX_EXCERPT_CHARS = 320
MAX_EXCERPTS = 5

NOTICES = {
    "ai_unavailable": (
        "AI analysis is temporarily unavailable. The information above was retrieved directly from your CRM."
    ),
    "ai_disabled": (
        "Generative AI is switched off for this workspace. The information above was retrieved directly from your CRM."
    ),
    "monthly_budget": (
        "This workspace has reached its AI budget for the month. The information above was retrieved directly "
        "from your CRM."
    ),
    "user_quota": (
        "You have reached your AI limit for this hour. The information above was retrieved directly from your CRM."
    ),
    "org_quota": (
        "This workspace has used its AI budget for today. The information above was retrieved directly from your CRM."
    ),
}

HEADLINES = {
    intent_module.MY_DAY: "Here is your day",
    intent_module.CRM_ANALYTICS: "Your numbers",
    intent_module.FORECAST: "Your forecast",
    intent_module.DEAL_ANALYSIS: "Deals that need attention",
    intent_module.ACTIVITY_QUERY: "Your schedule",
    intent_module.COMMUNICATION_SEARCH: "What was said",
    intent_module.CUSTOMER_HISTORY: "Recent history",
    intent_module.CRM_LOOKUP: "From your CRM",
}


def excerpt_section(chunks: list[Any], *, title: str = "From your conversations") -> Section:
    """Retrieved evidence, quoted and attributed. Never paraphrased -- that needs a model."""
    items: list[dict[str, Any]] = []
    for chunk in chunks[:MAX_EXCERPTS]:
        text = chunk.content.strip()
        items.append(
            {
                "id": str(chunk.chunk_id),
                "type": chunk.source_type,
                "label": chunk.label,
                "title": chunk.entity_name or chunk.label,
                "snippet": text[:MAX_EXCERPT_CHARS] + ("…" if len(text) > MAX_EXCERPT_CHARS else ""),
                "occurred_at": chunk.occurred_at.isoformat() if chunk.occurred_at else None,
                "href": _entity_href(chunk.entity_type, chunk.entity_id),
            }
        )
    return Section(title=title, kind="events", items=items, hint="Quoted from your CRM records")


def _entity_href(entity_type: str, entity_id: Any) -> str:
    if not entity_type or entity_id is None:
        return ""
    path = {"contact": "contacts", "company": "companies", "deal": "deals", "product": "products"}.get(entity_type)
    return f"/{path}/{entity_id}" if path else ""


def build(
    *,
    question: str,
    intent: Any,
    tools: ToolResult,
    chunks: list[Any],
    reason: str,
    degraded_retrieval: bool = False,
) -> dict[str, Any]:
    """Assemble the retrieval-only answer. Same response shape as the AI path, so the UI is identical."""
    sections = [section.as_dict() for section in tools.sections]
    if chunks:
        sections.append(excerpt_section(chunks).as_dict())

    headline = tools.headline or HEADLINES.get(intent.name, "From your CRM")
    facts = list(tools.facts)
    if not facts and not sections:
        facts.append(_nothing_found(intent))

    return {
        "answer_type": tools.answer_type,
        "mode": MODE_RETRIEVAL,
        "headline": headline,
        "facts": facts,
        "analysis": "",
        "recommendation": tools.recommendation,
        "sections": sections,
        "notice": NOTICES.get(reason, NOTICES["ai_unavailable"]),
        "degraded_retrieval": degraded_retrieval,
    }


def _nothing_found(intent: Any) -> str:
    if intent.entity_hints:
        return (
            f"Nothing in your CRM matches “{intent.entity_hints[0]}”. It may belong to a colleague, "
            "or the name may be spelled differently here."
        )
    return "Nothing in your CRM matches that question yet."
