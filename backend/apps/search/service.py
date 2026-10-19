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
from django.db.models import F, Q, QuerySet

from apps.authz.actor import Actor
from apps.authz.service import scope

MAX_QUERY_LENGTH = 200
MAX_PER_TYPE = 20
DEFAULT_PER_TYPE = 5
MAX_TERMS = 8
_WS = re.compile(r"\s+")
_TOKEN = re.compile(r"[^\w]+", re.UNICODE)


@dataclass(frozen=True)
class SearchTarget:
    entity_type: str
    permission: str
    model: Any
    like_fields: tuple[str, ...]
    select_related: tuple[str, ...] = ()
    archivable: bool = True
    # Columns that feed the stored search vector (see the module's search_vector_trigger migration).
    vector_fields: tuple[str, ...] = ()

    def base(self) -> QuerySet:
        qs = self.model.objects.filter(archived_at__isnull=True) if self.archivable else self.model.objects.all()
        if self.select_related:
            qs = qs.select_related(*self.select_related)
        return qs


def targets() -> dict[str, SearchTarget]:
    from apps.activities.models import Activity
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal
    from apps.products.models import Product

    return {
        "activity": SearchTarget(
            "activity", "activities.view", Activity, ("title",), ("deal", "contact"), archivable=False
        ),
        "contact": SearchTarget(
            "contact",
            "contacts.view",
            Contact,
            ("first_name", "last_name", "email", "phone"),
            ("company",),
            vector_fields=("first_name", "last_name", "email", "phone", "job_title", "description"),
        ),
        "company": SearchTarget(
            "company",
            "companies.view",
            Company,
            ("name", "website", "phone"),
            vector_fields=("name", "website", "phone", "industry", "description"),
        ),
        "deal": SearchTarget(
            "deal",
            "deals.view",
            Deal,
            ("name",),
            ("stage", "company"),
            vector_fields=("name", "description", "lost_reason"),
        ),
        "product": SearchTarget(
            "product", "products.view", Product, ("name", "sku"), vector_fields=("name", "sku", "description")
        ),
    }


# Values shown in a result, per entity, and the field each one reveals (for field permissions).
_SUMMARY_FIELDS: dict[str, dict[str, tuple[str, ...]]] = {
    "contact": {"subtitle": ("email", "phone"), "meta": ("company",)},
    "company": {"subtitle": ("website",), "meta": ("industry",)},
    "deal": {"subtitle": ("amount",), "meta": ("stage",)},
    "product": {"subtitle": ("sku",), "meta": ("unit_price",)},
}


def _mask_summary(entity_type: str, summary: dict[str, Any], hidden: frozenset[str], obj: Any) -> dict[str, Any]:
    """Blank any summary part that would show a field the actor may not see."""
    if not hidden:
        return summary
    if entity_type == "contact" and "subtitle" in summary:
        email = "" if "email" in hidden else obj.email
        phone = "" if "phone" in hidden else obj.phone
        summary["subtitle"] = email or phone
    for part, fields in _SUMMARY_FIELDS.get(entity_type, {}).items():
        if entity_type == "contact" and part == "subtitle":
            continue
        if any(f in hidden for f in fields):
            summary[part] = ""
    return summary


def normalise(q: str) -> str:
    q = _WS.sub(" ", (q or "").replace("\x00", "")).strip()
    return q[:MAX_QUERY_LENGTH]


def prefix_tsquery(q: str) -> str | None:
    """Build a ``to_tsquery`` string: every term must match, the last term as a prefix (``jo:*`` finds
    "John" while typing). Terms are reduced to word characters only, so the text can never be read as
    tsquery syntax; the string is still passed as a bound parameter.

    Prefix matching keeps every entity query on its GIN index. The previous ``icontains`` OR fallback
    forced a sequential scan over the organization's rows for each search.
    """
    terms = [t for t in _TOKEN.split(q.lower()) if t][:MAX_TERMS]
    if not terms:
        return None
    terms[-1] = f"{terms[-1]}:*"
    return " & ".join(terms)


def _summary(entity_type: str, obj: Any) -> dict[str, Any]:
    if entity_type == "activity":
        related = obj.deal.name if obj.deal_id else (obj.contact.display_name if obj.contact_id else "")
        when = obj.start_at.strftime("%d %b %H:%M") if obj.start_at else ""
        return {
            "id": str(obj.pk),
            "type": "activity",
            "title": obj.title,
            "subtitle": f"{obj.get_kind_display()} · {obj.get_status_display()}",
            "meta": " · ".join(x for x in (related, when) if x),
        }
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
    raw = prefix_tsquery(q)
    if raw is None:
        return {"query": q, "results": {t: [] for t in wanted}}
    tsquery = SearchQuery(raw, search_type="raw", config="simple")
    from apps.authz import fields as field_rules
    from apps.pipelines.access import can_access

    for target_name in wanted:
        target = all_targets[target_name]
        qs = scope(actor, target.permission, target.base())
        hidden = field_rules.hidden_fields(actor, target_name) if target_name != "activity" else frozenset()
        if hidden & set(target.vector_fields):
            # The stored vector includes a field this actor may not see: matching on it would reveal the
            # hidden value ("which contact has this phone number?"). Match visible columns only instead.
            terms = [t for t in _TOKEN.split(q.lower()) if t][:MAX_TERMS]
            visible = [f for f in target.like_fields if f not in hidden]
            for term in terms:
                cond = Q()
                for f in visible:
                    cond |= Q(**{f"{f}__icontains": term})
                qs = qs.filter(cond) if visible else qs.none()
            qs = qs.order_by("-updated_at")[:per_type]
        else:
            qs = (
                # F() keeps ts_rank on the stored vector. A bare column name would make Django wrap it in
                # to_tsvector(COALESCE(search_vector::text)), re-parsing the vector for every candidate row:
                # 25k-contact tenants paid ~500 ms per search for that before this change.
                qs.annotate(rank=SearchRank(F("search_vector"), tsquery))
                .filter(search_vector=tsquery)
                .order_by("-rank", "-updated_at")[:per_type]
            )
        summaries = []
        for obj in qs:
            summary = _mask_summary(target_name, _summary(target_name, obj), hidden, obj)
            if target_name == "activity" and obj.deal_id and not can_access(actor, obj.deal.pipeline_id):
                summary["meta"] = obj.contact.display_name if obj.contact_id else ""  # restricted pipeline
            summaries.append(summary)
        results[target_name] = summaries
    return {"query": q, "results": results}
