"""Phone-number matching helpers: compare digits only, whatever punctuation the number was typed with."""

from __future__ import annotations

import re

from django.db.models import Value
from django.db.models.functions import Replace

_DIGITS = re.compile(r"\D+")


def digits(value: str | None) -> str:
    return _DIGITS.sub("", value or "")


def phone_digits_expression(field: str = "phone"):
    """Database expression stripping the punctuation ``clean_phone`` allows (spaces, ``+ ( ) - .``)."""
    expr = Replace(field, Value(" "), Value(""))
    for char in ("-", "(", ")", "+", "."):
        expr = Replace(expr, Value(char), Value(""))
    return expr


def match_suffix(value: str | None, suffix_length: int = 10) -> str:
    """The national significant part used for matching (last ``suffix_length`` digits)."""
    return digits(value)[-suffix_length:]
