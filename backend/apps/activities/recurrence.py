"""RRULE recurrence for events (meetings) and tasks (RFC 5545 ``RRULE`` only).

Accepted: ``FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`` with ``INTERVAL``, ``COUNT``, ``UNTIL``, ``BYDAY``,
``BYMONTHDAY``, ``BYMONTH``, ``BYSETPOS``, ``WKST``. Refused: sub-daily frequencies (an hourly rule is a
denial-of-service on the calendar, not a meeting), ``DTSTART``/``RDATE``/``EXRULE`` (the start is the
activity's own ``start_at``), anything longer than 255 characters.

Events are stored once and expanded into occurrences for a requested range (``occurrences``). Tasks
are materialised one occurrence at a time: completing one creates the next (``next_after``).
"""

from __future__ import annotations

import datetime as dt
import re

from dateutil.rrule import rrule, rrulestr
from rest_framework.exceptions import ValidationError

MAX_RULE_LENGTH = 255
MAX_COUNT = 1000
MAX_OCCURRENCES_PER_RANGE = 500
ALLOWED_FREQ = frozenset({"DAILY", "WEEKLY", "MONTHLY", "YEARLY"})
ALLOWED_PARTS = frozenset({"FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"})
_PART = re.compile(r"^[A-Z]+=[A-Z0-9,+\-]+$")


def clean(rule: str | None) -> str:
    """Normalise and validate a rule. Returns "" for no recurrence."""
    rule = (rule or "").strip()
    if not rule:
        return ""
    if rule.upper().startswith("RRULE:"):
        rule = rule[6:]
    rule = rule.upper()
    if len(rule) > MAX_RULE_LENGTH:
        raise ValidationError({"recurrence": "The recurrence rule is too long."})
    parts: dict[str, str] = {}
    for part in rule.split(";"):
        if not _PART.match(part):
            raise ValidationError({"recurrence": "Invalid recurrence rule."})
        key, value = part.split("=", 1)
        if key not in ALLOWED_PARTS or key in parts:
            raise ValidationError({"recurrence": f"'{key}' is not supported in a recurrence rule."})
        parts[key] = value
    if parts.get("FREQ") not in ALLOWED_FREQ:
        raise ValidationError({"recurrence": "Repeat daily, weekly, monthly or yearly."})
    if "COUNT" in parts and "UNTIL" in parts:
        raise ValidationError({"recurrence": "Use COUNT or UNTIL, not both."})
    if "COUNT" in parts and not (parts["COUNT"].isdigit() and 1 <= int(parts["COUNT"]) <= MAX_COUNT):
        raise ValidationError({"recurrence": f"COUNT must be 1 to {MAX_COUNT}."})
    if "INTERVAL" in parts and not (parts["INTERVAL"].isdigit() and 1 <= int(parts["INTERVAL"]) <= 366):
        raise ValidationError({"recurrence": "INTERVAL must be 1 to 366."})
    try:
        rrulestr(rule, dtstart=dt.datetime(2026, 1, 1, tzinfo=dt.UTC))
    except (ValueError, TypeError) as exc:
        raise ValidationError({"recurrence": "Invalid recurrence rule."}) from exc
    return ";".join(f"{k}={v}" for k, v in parts.items())


def _rule(rule: str, start: dt.datetime) -> rrule:
    parsed = rrulestr(rule, dtstart=start)
    assert isinstance(parsed, rrule)
    return parsed


def occurrences(rule: str, start: dt.datetime, range_start: dt.datetime, range_end: dt.datetime) -> list[dt.datetime]:
    """Occurrence starts within ``[range_start, range_end]``, at most ``MAX_OCCURRENCES_PER_RANGE``."""
    out: list[dt.datetime] = []
    for when in _rule(rule, start).xafter(range_start - dt.timedelta(microseconds=1), inc=True):
        if when > range_end or len(out) >= MAX_OCCURRENCES_PER_RANGE:
            break
        out.append(when)
    return out


def next_after(rule: str, anchor: dt.datetime, after: dt.datetime) -> dt.datetime | None:
    """The first occurrence strictly after ``after`` of the series that started at ``anchor``."""
    return _rule(rule, anchor).after(after, inc=False)
