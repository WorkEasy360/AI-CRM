"""Tenant- and permission-scoped global search over PostgreSQL full text (ADR-0011).

Every entity query starts from the tenant-scoped manager and passes through ``authz.scope()`` for the
entity's view permission, so a result can only ever be a row the actor could open directly. The text
is passed as a bound parameter to ``websearch_to_tsquery`` (never interpolated).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from django.contrib.postgres.search import SearchQuery, SearchRank
from django.db.models import Q, QuerySet

from apps.authz.actor import Actor
from apps.authz.service import scope

MAX_QUERY_LENGTH = 200
MAX_PER_TYPE = 20
DEFAULT_PER_TYPE = 5
_WS = re.compile(r"\s+")


@dataclass(frozen=True)
class SearchTarget:
    entity_type: str
    permission: str
    model: Any
    like_fields: tuple[str, ...]
    select_related: tuple[str, ...] = ()

    def base(self) -> QuerySet:
        qs = self.model.objects.filter(archived_at__isnull=True)
        if self.select_related:
            qs = qs.select_related(*self.select_related)
        return qs


def targets() -> dict[str, SearchTarget]:
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal
    from apps.products.models import Product

    return {
        "contact": SearchTarget(
            "contact", "contacts.view", Contact, ("first_name", "last_name", "email", "phone"), ("company",)
        ),
        "company": SearchTarget("company", "companies.view", Company, ("name", "website", "phone")),
        "deal": SearchTarget("deal", "deals.view", Deal, ("name",), ("stage", "company")),
        "product": SearchTarget("product", "products.view", Product, ("name", "sku")),
    }


def normalise(q: str) -> str:
    q = _WS.sub(" ", (q or "").replace("\x00", "")).strip()
    return q[:MAX_QUERY_LENGTH]


def _summary(entity_type: str, obj: Any) -> dict[str, Any]:
    if entity_type == "contact":
        return {
            "id": str(obj.pk),
            "type": "contact",
            "title": obj.display_name,
            "subtitle": obj.email or obj.phone,
            "meta": obj.company.name if obj.company_id else "",
        }
    if entity_type == "company":
        return {"id": str(obj.pk), "type": "company", "title": obj.name, "subtitle": obj.website, "meta": obj.industry}
    if entity_type == "deal":
        return {
            "id": str(obj.pk),
            "type": "deal",
            "title": obj.name,
            "subtitle": f"{obj.amount} {obj.currency}",
            "meta": obj.stage.name if obj.stage_id else "",
        }
    return {
        "id": str(obj.pk),
        "type": "product",
        "title": obj.name,
        "subtitle": obj.sku,
        "meta": f"{obj.unit_price} {obj.currency}",
    }


def search(actor: Actor, q: str, *, types: list[str] | None = None, per_type: int = DEFAULT_PER_TYPE) -> dict[str, Any]:
    q = normalise(q)
    per_type = max(1, min(per_type, MAX_PER_TYPE))
    all_targets = targets()
    wanted = [t for t in (types or list(all_targets)) if t in all_targets]
    results: dict[str, list[dict[str, Any]]] = {}
    if not q:
        return {"query": q, "results": {t: [] for t in wanted}}
    tsquery = SearchQuery(q, search_type="websearch", config="simple")
    # Prefix match on the last word so "jo" already finds "John" while typing.
    like = Q()
    for target_name in wanted:
        target = all_targets[target_name]
        like = Q()
        for f in target.like_fields:
            like |= Q(**{f"{f}__icontains": q})
        qs = scope(actor, target.permission, target.base())
        qs = (
            qs.annotate(rank=SearchRank("search_vector", tsquery))
            .filter(Q(search_vector=tsquery) | like)
            .order_by("-rank", "-updated_at")[:per_type]
        )
        results[target_name] = [_summary(target_name, obj) for obj in qs]
    return {"query": q, "results": results}
