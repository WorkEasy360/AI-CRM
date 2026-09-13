"""Shared input validators for CRM text, URLs, phone numbers, currency codes and JSON addresses.

They are deliberately strict about *shape* (length, scheme, character classes) and permissive about
*content*: user text is stored verbatim and rendered by React, so HTML is data, not markup. Control
characters are stripped because they carry no meaning in a CRM field and break CSV/JSON consumers.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from rest_framework import serializers

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_PHONE_RE = re.compile(r"^[0-9+()\-.\s]{3,32}$")
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_HOST_PORT_RE = re.compile(r"^[A-Za-z0-9.-]+:\d{1,5}(/|$)")
ADDRESS_KEYS = frozenset({"line1", "line2", "city", "state", "postal_code", "country"})
MAX_ADDRESS_VALUE = 120
MAX_AMOUNT = Decimal("9999999999999999.99")


def clean_text(value: str | None, *, max_length: int, allow_newlines: bool = False) -> str:
    if value is None:
        return ""
    value = _CONTROL_RE.sub("", str(value))
    if not allow_newlines:
        value = value.replace("\n", " ").replace("\r", " ")
    value = value.strip()
    if len(value) > max_length:
        raise serializers.ValidationError(f"Ensure this value has at most {max_length} characters.")
    return value


def clean_url(value: str | None) -> str:
    """Accept http(s) URLs only. Scheme-less input gets https://. Anything else is rejected."""
    if not value:
        return ""
    value = clean_text(value, max_length=2048)
    if not value:
        return ""
    if "://" not in value:
        # "javascript:alert(1)", "data:...", "mailto:" must never become https://javascript:...
        if _SCHEME_RE.match(value) and not _HOST_PORT_RE.match(value):
            raise serializers.ValidationError("Only http and https URLs are allowed.")
        value = "https://" + value
    parts = urlsplit(value)
    if parts.scheme.lower() not in {"http", "https"}:
        raise serializers.ValidationError("Only http and https URLs are allowed.")
    if not parts.netloc or any(c.isspace() for c in parts.netloc):
        raise serializers.ValidationError("Enter a valid URL.")
    if "@" in parts.netloc:
        raise serializers.ValidationError("Credentials in URLs are not allowed.")
    return value


def clean_phone(value: str | None) -> str:
    if not value:
        return ""
    value = clean_text(value, max_length=32)
    if value and not _PHONE_RE.match(value):
        raise serializers.ValidationError("Enter a valid phone number.")
    return value


def clean_currency(value: str | None, *, default: str) -> str:
    code = (value or default or "").strip().upper()
    if not _CURRENCY_RE.match(code):
        raise serializers.ValidationError("Currency must be a 3-letter ISO 4217 code.")
    return code


def clean_amount(value: Decimal | None, *, allow_negative: bool = False) -> Decimal | None:
    if value is None:
        return None
    if not value.is_finite():
        raise serializers.ValidationError("Enter a finite number.")
    if not allow_negative and value < 0:
        raise serializers.ValidationError("Must be zero or positive.")
    if abs(value) > MAX_AMOUNT:
        raise serializers.ValidationError("Amount is too large.")
    return value.quantize(Decimal("0.01"))


def clean_address(value: Any) -> dict[str, str]:
    if value in (None, ""):
        return {}
    if not isinstance(value, dict):
        raise serializers.ValidationError("Address must be an object.")
    out: dict[str, str] = {}
    for key, raw in value.items():
        if key not in ADDRESS_KEYS:
            raise serializers.ValidationError(f"Unknown address field '{key}'.")
        if raw in (None, ""):
            continue
        if not isinstance(raw, str):
            raise serializers.ValidationError(f"Address field '{key}' must be text.")
        out[key] = clean_text(raw, max_length=MAX_ADDRESS_VALUE)
    return out
