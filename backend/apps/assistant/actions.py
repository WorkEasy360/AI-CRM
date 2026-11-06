"""Action requests ("create a task for tomorrow to call ABC Corp"): proposed here, confirmed by the user.

The assistant never writes. It works out *what* the user asked for -- the kind of record, a title, a
due date and the customer it is about -- and returns that as a proposal. The UI opens the normal
create form pre-filled with it; nothing exists until the user presses Save there, and that save goes
through the same API, validation, permission checks and audit trail as any other create.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from django.utils import timezone

from apps.assistant import crm_tools
from apps.authz.actor import Actor

KINDS: tuple[tuple[str, str], ...] = (
    ("meeting", r"\bmeetings?\b|\bappointments?\b"),
    ("call", r"\bcalls?\b"),
    ("ticket", r"\btickets?\b"),
    ("deal", r"\bdeals?\b|\bopportunit(y|ies)\b"),
    ("company", r"\bcompan(y|ies)\b"),
    ("contact", r"\bcontacts?\b|\bleads?\b"),
    ("task", r"\btasks?\b|\bfollow[ -]?ups?\b|\breminders?\b|\bremind me\b|\bto-?dos?\b"),
)
PERMISSIONS = {
    "task": "activities.create",
    "call": "activities.create",
    "meeting": "activities.create",
    "deal": "deals.create",
    "contact": "contacts.create",
    "company": "companies.create",
    "ticket": "tickets.create",
}
LABELS = {
    "task": "task",
    "call": "call",
    "meeting": "meeting",
    "deal": "deal",
    "contact": "contact",
    "company": "company",
    "ticket": "ticket",
}
_KIND_WORDS = r"task|call|meeting|follow[ -]?up|reminder|deal|contact|company|ticket"
_LEAD = re.compile(
    r"^\s*(please |can you |could you |kindly )?"
    r"(create|add|schedule|book|set up|log|make|remind me( to)?|set an? reminder( to)?|new)\s+(me\s+)?"
    r"(a |an |the )?(new )?(?:(?P<noun>" + _KIND_WORDS + r")s?\b)?\s*(?P<prep>for|to|with|about|on)?\s*",
    re.IGNORECASE,
)
_HINGLISH_VERB = re.compile(
    r"\b(bana do|bana de|banao|bana dijiye|create karo|add karo|schedule karo|set karo|laga do|daal do|add kar do"
    r"|create kar do)\b",
    re.IGNORECASE,
)
_LEADING_KIND = re.compile(r"^\s*(" + _KIND_WORDS + r")s?\b\s*", re.IGNORECASE)
_LEADING_PREP = re.compile(r"^\s*(to|for|with|about|on|ke liye)\b\s*", re.IGNORECASE)
_WHEN = (
    (r"\b(day after tomorrow|parso|parson)\b", 2),
    (r"\b(tomorrow|kal)\b", 1),
    (r"\b(today|aaj)\b", 0),
    (r"\bnext week\b|\bagle hafte\b", 7),
)
_FILLER = re.compile(r"\b(ke liye|ka|ki|ke|for|on|by|to)\s*$", re.IGNORECASE)


_NOUN_KIND = {"follow up": "task", "follow-up": "task", "followup": "task", "reminder": "task"}


def _kind(text: str) -> str:
    # The record named right after the verb wins: "create a task to call ABC" is a task, not a call.
    lead = _LEAD.match(text)
    noun = (lead.group("noun") or "").lower() if lead else ""
    if not noun:
        leading = _LEADING_KIND.match(text)  # Hinglish puts the record first: "task bana do ..."
        noun = leading.group(1).lower() if leading and _HINGLISH_VERB.search(text) else ""
    if noun:
        return _NOUN_KIND.get(noun, noun)
    for kind, pattern in KINDS:
        if re.search(pattern, text, re.IGNORECASE):
            return kind
    return "task"


def _due(text: str) -> tuple[str, str]:
    for pattern, days in _WHEN:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return (timezone.localdate() + dt.timedelta(days=days)).isoformat(), match.group(0)
    return "", ""


def _title(text: str, when: str, kind: str) -> str:
    lead = _LEAD.match(text)
    title = text[lead.end() :] if lead and lead.end() else text
    title = _HINGLISH_VERB.sub(" ", title)
    title = _LEADING_KIND.sub("", title, count=1)
    if when:
        title = re.sub(rf"\b{re.escape(when)}\b", " ", title, flags=re.IGNORECASE)
    title = re.sub(r"\s+", " ", title).strip(" .,?!-")
    for _ in range(2):
        title = _LEADING_PREP.sub("", title).strip(" .,?!-")
        title = _FILLER.sub("", title).strip(" .,?!-")
    if title and kind in {"meeting", "call"} and lead and (lead.group("prep") or "").lower() == "with":
        title = f"{kind.title()} with {title}"
    return (title[:1].upper() + title[1:])[:200] if title else ""


def propose(actor: Actor, parsed: Any, records: list[tuple[str, Any]]) -> dict[str, Any]:
    text = parsed.question
    kind = _kind(text)
    due, when = _due(text)
    title = _title(text, when, kind) if kind in {"task", "call", "meeting", "deal", "ticket"} else ""
    allowed = actor.has(PERMISSIONS[kind])
    links = {}
    for entity_type, record in records[:1]:
        if entity_type in {"contact", "company", "deal"}:
            links[entity_type] = {"id": str(record.pk), "name": crm_tools._title(entity_type, record)}
    label = LABELS[kind]
    if not allowed:
        headline = f"Your role can't create a {label}."
        analysis = "Ask your workspace admin for access."
    else:
        headline = f"Ready to create a {label}. Review the details and click Save to confirm."
        analysis = "Nothing is saved until you confirm in the form."
    return {
        "answer_type": "action",
        "mode": "retrieval",
        "headline": headline,
        "facts": [],
        "analysis": analysis,
        "recommendation": "",
        "sections": [],
        "notice": "",
        "flagged_input": False,
        "action": {
            "kind": kind,
            "title": title,
            "due_date": due,
            "links": links,
            "permission_ok": allowed,
        },
    }
