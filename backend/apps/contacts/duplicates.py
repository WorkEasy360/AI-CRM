"""Duplicate detection for contacts and companies, limited to the actor's view scope.

Matches are advisory: the UI warns before saving, nothing is blocked (a second contact at the same
company with the same name is legitimate often enough). Comparisons are exact after normalisation, so
every lookup stays on an index and no fuzzy scan runs over the tenant's rows.
"""

from __future__ import annotations

import re
import uuid
from typing import Any
from urllib.parse import urlsplit

from django.db.models import Q

from apps.authz.actor import Actor
from apps.authz.service import scope

MAX_RESULTS = 5
_DIGITS = re.compile(r"\D+")


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


def normalise_phone(value: str) -> str:
    return _DIGITS.sub("", value or "")[-10:]  # national significant digits are enough to match


def find_contact_duplicates(
    actor: Actor,
    *,
    email: str = "",
    phone: str = "",
    first_name: str = "",
    last_name: str = "",
    exclude_id: Any = None,
) -> list[dict[str, Any]]:
    from apps.contacts.models import Contact

    email = (email or "").strip().lower()[:254]
    first_name = (first_name or "").strip()[:80]
    last_name = (last_name or "").strip()[:80]
    digits = normalise_phone(phone)
    cond = Q()
    reasons: list[tuple[str, Q]] = []
    if email:
        reasons.append(("email", Q(email=email)))
    if len(digits) >= 6:
        reasons.append(("phone", Q(phone_digits__endswith=digits)))
    if first_name and last_name:
        reasons.append(("name", Q(first_name__iexact=first_name, last_name__iexact=last_name)))
    if not reasons:
        return []
    for _, q in reasons:
        cond |= q
    qs = scope(actor, "contacts.view", Contact.objects.filter(archived_at__isnull=True))
    if len(digits) >= 6:
        from apps.contacts.phones import phone_digits_expression

        # Compare digits only: "+91 98765-43210" and "9876543210" are the same number.
        qs = qs.annotate(phone_digits=phone_digits_expression())
    excluded = _uuid(exclude_id)
    if excluded:
        qs = qs.exclude(pk=excluded)
    rows = list(qs.filter(cond).select_related("company").order_by("-updated_at")[:MAX_RESULTS])
    out = []
    for c in rows:
        matched = []
        if email and c.email == email:
            matched.append("email")
        if len(digits) >= 6 and normalise_phone(c.phone).endswith(digits):
            matched.append("phone")
        if (
            first_name
            and last_name
            and c.first_name.lower() == first_name.lower()
            and c.last_name.lower() == last_name.lower()
        ):
            matched.append("name")
        out.append(
            {
                "id": str(c.pk),
                "display_name": c.display_name,
                "email": c.email,
                "phone": c.phone,
                "company": {"id": str(c.company_id), "name": c.company.name} if c.company_id else None,
                "matched_on": matched or ["name"],
            }
        )
    return out


def website_host(value: str) -> str:
    value = (value or "").strip().lower()
    if not value:
        return ""
    if "://" not in value:
        value = "https://" + value
    host = urlsplit(value).netloc.split("@")[-1].split(":")[0]
    return host.removeprefix("www.")


def find_company_duplicates(
    actor: Actor, *, name: str = "", website: str = "", exclude_id: Any = None
) -> list[dict[str, Any]]:
    from apps.companies.models import Company

    name = (name or "").strip()[:160]
    host = website_host(website)[:253]
    cond = Q()
    if name:
        cond |= Q(name__iexact=name)
    if host:
        cond |= Q(website__icontains=host)
    if not cond:
        return []
    qs = scope(actor, "companies.view", Company.objects.filter(archived_at__isnull=True))
    excluded = _uuid(exclude_id)
    if excluded:
        qs = qs.exclude(pk=excluded)
    rows = list(qs.filter(cond).order_by("-updated_at")[:MAX_RESULTS])
    out = []
    for c in rows:
        matched = []
        if name and c.name.lower() == name.lower():
            matched.append("name")
        if host and host in (c.website or "").lower():
            matched.append("website")
        out.append(
            {
                "id": str(c.pk),
                "name": c.name,
                "website": c.website,
                "industry": c.industry,
                "matched_on": matched or ["name"],
            }
        )
    return out
