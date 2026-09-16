"""Deterministic intent routing, before any model is involved.

The router decides *where the answer comes from*, not what the answer is. That decision is rules, not
inference, for three reasons: a question like "what is my pipeline value" must be answered by SQL
every time (a model asked to add up money will eventually add it up wrong); routing has to work when
no model is available at all; and a deterministic router costs nothing and cannot be steered by text
inside a customer's email.

The model still writes the prose. It just never chooses the evidence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

CRM_LOOKUP = "crm_lookup"
CRM_ANALYTICS = "crm_analytics"
CUSTOMER_HISTORY = "customer_history"
DEAL_ANALYSIS = "deal_analysis"
ACTIVITY_QUERY = "activity_query"
COMMUNICATION_SEARCH = "communication_search"
FORECAST = "forecast"
DRAFT_GENERATION = "draft_generation"
MY_DAY = "my_day"
GENERAL_CRM_QUESTION = "general_crm_question"

INTENTS = (
    CRM_LOOKUP,
    CRM_ANALYTICS,
    CUSTOMER_HISTORY,
    DEAL_ANALYSIS,
    ACTIVITY_QUERY,
    COMMUNICATION_SEARCH,
    FORECAST,
    DRAFT_GENERATION,
    MY_DAY,
    GENERAL_CRM_QUESTION,
)

# Intents whose evidence is unstructured text and therefore needs the knowledge index.
NEEDS_RETRIEVAL = frozenset({CUSTOMER_HISTORY, COMMUNICATION_SEARCH, DEAL_ANALYSIS, GENERAL_CRM_QUESTION})
# Intents whose numbers must come from SQL, never from a vector search.
NEEDS_STRUCTURED = frozenset(
    {CRM_LOOKUP, CRM_ANALYTICS, DEAL_ANALYSIS, ACTIVITY_QUERY, FORECAST, MY_DAY, CUSTOMER_HISTORY}
)

_RULES: tuple[tuple[str, str], ...] = (
    # Order matters: the first pattern that matches wins, so the most specific phrasings come first.
    (MY_DAY, r"\b(what should i|my day|today'?s? (plan|agenda|priorit)|focus on today|follow up today)\b"),
    (MY_DAY, r"\b(what do i (need to )?do|where should i start)\b"),
    (FORECAST, r"\b(forecast|projected|projection|expected revenue|quota|how much will (we|i) close)\b"),
    (
        CRM_ANALYTICS,
        r"\b(how (much|many)|total|sum|average|count|win rate|conversion rate|pipeline value|revenue)\b",
    ),
    (CRM_ANALYTICS, r"\b(summari[sz]e|summary of) (my |the |our )?(pipeline|deals|sales|numbers)\b"),
    (DEAL_ANALYSIS, r"\b(at risk|risky|risk|stuck|stalled|slipping|need attention|needs attention|going wrong)\b"),
    (DEAL_ANALYSIS, r"\bwhy (is|are|has|did)\b"),
    (ACTIVITY_QUERY, r"\b(meeting|meetings|call|calls|task|tasks|overdue|due|calendar|schedule|appointment)\b"),
    (
        COMMUNICATION_SEARCH,
        r"\b(said|say|says|mention|mentioned|discuss|discussed|talked about|complain|concern|asked about"
        r"|replied|responded|email|emails|whatsapp|message|messages|conversation)\b",
    ),
    (DRAFT_GENERATION, r"\b(draft|write|compose|reply to|respond to|rewrite|shorten) (a |an |the )?\b"),
    (CUSTOMER_HISTORY, r"\b(what happened|history|recap|catch me up|bring me up to speed|last time|update on)\b"),
    (CRM_LOOKUP, r"\b(show|list|find|which|who|when|where)\b"),
)
_COMPILED = tuple((intent, re.compile(pattern, re.IGNORECASE)) for intent, pattern in _RULES)

# Phrases that introduce the customer a question is about.
_ABOUT = re.compile(
    r"\b(?:with|about|for|from|at|on|regarding|re)\s+(?P<name>[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})",
)
# Straight and typographic quotes: people paste a name out of an email as often as they type it.
_SMART_QUOTES = "".join(chr(code) for code in (0x201C, 0x201D, 0x2018, 0x2019))
_QUOTED = re.compile(f"[\"'{_SMART_QUOTES}]([^\"'{_SMART_QUOTES}]{{2,60}})[\"'{_SMART_QUOTES}]")
_CAPITALISED = re.compile(r"\b([A-Z][\w&.'-]{1,}(?:\s+[A-Z][\w&.'-]+){0,3})\b")
# Sentence-initial and otherwise capitalised words that are never a customer name.
_NOT_A_NAME_WORDS = """
    what who when where which why how show list find summarize summarise tell give me my our the a an is are
    was were do does did should could would can will i keel crm deal deals pipeline forecast today tomorrow
    yesterday this week month quarter year monday tuesday wednesday thursday friday saturday sunday january
    february march april may june july august september october november december
"""
# split() rather than a literal list: the data is a word list, and it should look like one.
_NOT_A_NAME = frozenset(_NOT_A_NAME_WORDS.split())

# Money phrasings used by the amount filter ("deals above 5 lakh", "over $50,000").
_AMOUNT = re.compile(
    r"\b(?:above|over|more than|greater than|at least|>=?)\s*"
    r"(?:[₹$€£]\s*)?(?P<value>[\d,.]+)\s*(?P<unit>lakh|lakhs|lac|crore|crores|k|m|million|thousand)?",
    re.IGNORECASE,
)
_UNITS = {
    "k": 1_000,
    "thousand": 1_000,
    "m": 1_000_000,
    "million": 1_000_000,
    "lakh": 100_000,
    "lakhs": 100_000,
    "lac": 100_000,
    "crore": 10_000_000,
    "crores": 10_000_000,
}

_TIME_WINDOWS: tuple[tuple[str, str], ...] = (
    ("today", r"\btoday\b"),
    ("this_week", r"\bthis week\b"),
    ("next_week", r"\bnext week\b"),
    ("this_month", r"\bthis month\b"),
    ("last_month", r"\blast month\b"),
    ("this_quarter", r"\bthis quarter\b"),
    ("overdue", r"\boverdue\b"),
)


@dataclass
class Intent:
    name: str
    question: str
    entity_hints: list[str] = field(default_factory=list)
    time_window: str = ""
    min_amount: float | None = None
    wants_won: bool = False
    wants_open: bool = False

    @property
    def needs_retrieval(self) -> bool:
        return self.name in NEEDS_RETRIEVAL

    @property
    def needs_structured(self) -> bool:
        return self.name in NEEDS_STRUCTURED


def classify(question: str) -> Intent:
    text = (question or "").strip()
    name = GENERAL_CRM_QUESTION
    for candidate, pattern in _COMPILED:
        if pattern.search(text):
            name = candidate
            break
    # A question that names a customer *and* asks about conversations is customer history, not a
    # generic lookup: "what happened with ABC Corp" needs the timeline, not a record card.
    hints = entity_hints(text)
    if name == CRM_LOOKUP and hints and _ABOUT.search(text):
        name = CUSTOMER_HISTORY
    return Intent(
        name=name,
        question=text,
        entity_hints=hints,
        time_window=_time_window(text),
        min_amount=_min_amount(text),
        wants_won=bool(re.search(r"\b(won|closed won|winning)\b", text, re.IGNORECASE)),
        wants_open=bool(re.search(r"\b(open|active|in progress)\b", text, re.IGNORECASE)),
    )


def entity_hints(text: str) -> list[str]:
    """Candidate customer names in the question, best guess first. Resolved against real records
    later -- a hint that matches nothing simply produces no structured context."""
    hints: list[str] = []
    for match in _QUOTED.finditer(text):
        hints.append(match.group(1).strip())
    for match in _ABOUT.finditer(text):
        hints.append(match.group("name").strip())
    for match in _CAPITALISED.finditer(text):
        hints.append(match.group(1).strip())

    seen: set[str] = set()
    out: list[str] = []
    for hint in hints:
        cleaned = hint.strip(" .,?!")
        if not cleaned or len(cleaned) < 2:
            continue
        words = cleaned.lower().split()
        if all(word in _NOT_A_NAME for word in words):
            continue
        # Trim a leading filler word that the capitalised-run pattern swept up.
        while words and words[0] in _NOT_A_NAME:
            cleaned = cleaned.split(" ", 1)[1] if " " in cleaned else ""
            words = words[1:]
        if not cleaned or cleaned.lower() in seen:
            continue
        seen.add(cleaned.lower())
        out.append(cleaned)
    return out[:3]


def _time_window(text: str) -> str:
    for name, pattern in _TIME_WINDOWS:
        if re.search(pattern, text, re.IGNORECASE):
            return name
    return ""


def _min_amount(text: str) -> float | None:
    match = _AMOUNT.search(text)
    if not match:
        return None
    raw = match.group("value").replace(",", "").rstrip(".")
    try:
        value = float(raw)
    except ValueError:
        return None
    unit = (match.group("unit") or "").lower()
    return value * _UNITS.get(unit, 1)
