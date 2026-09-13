"""Extra sign-up input. allauth mixes this class into its signup form (ACCOUNT_SIGNUP_FORM_CLASS), so the
headless ``/auth/signup`` endpoint accepts the same field. Only a display name is collected here: the
organization is created automatically afterwards (see ``services.ensure_personal_organization``)."""

from __future__ import annotations

import re

from django import forms

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
MAX_NAME_LENGTH = 120
_NAME_PART_LENGTH = 80  # User.first_name / User.last_name


def split_name(name: str) -> tuple[str, str]:
    """ "Ada Lovelace" -> ("Ada", "Lovelace"); a single word is the first name."""
    first, _, last = name.strip().partition(" ")
    return first[:_NAME_PART_LENGTH], last.strip()[:_NAME_PART_LENGTH]


class SignupForm(forms.Form):
    name = forms.CharField(max_length=MAX_NAME_LENGTH, required=False, strip=True)

    def clean_name(self) -> str:
        value = self.cleaned_data.get("name") or ""
        value = _CONTROL_RE.sub("", value)
        return " ".join(value.split())[:MAX_NAME_LENGTH]

    def signup(self, request, user) -> None:
        """Called by allauth once the user row exists; stores the display name on the existing columns."""
        name = self.cleaned_data.get("name") or ""
        if not name:
            return
        user.first_name, user.last_name = split_name(name)
        user.save(update_fields=["first_name", "last_name"])
