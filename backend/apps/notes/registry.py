"""Resolve a (entity_type, entity_id) pair to a record the actor may *view*.

Notes, tags and the timeline all hang off records; this is the single place that maps an entity type to
its model and view permission, so a generic ``entity_id`` can never reach a record outside the actor's
view scope (404, never 403, to avoid existence leaks).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from django.http import Http404
from rest_framework.exceptions import ValidationError

from apps.authz.actor import Actor
from apps.authz.service import scope


@dataclass(frozen=True)
class EntityInfo:
    entity_type: str
    module: str
    model: Any


def _registry() -> dict[str, EntityInfo]:
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal
    from apps.products.models import Product

    return {
        "contact": EntityInfo("contact", "contacts", Contact),
        "company": EntityInfo("company", "companies", Company),
        "deal": EntityInfo("deal", "deals", Deal),
        "product": EntityInfo("product", "products", Product),
    }


def entity_info(entity_type: str) -> EntityInfo:
    info = _registry().get(entity_type or "")
    if info is None:
        raise ValidationError({"entity_type": "Unknown entity type."})
    return info


def resolve_viewable(actor: Actor, entity_type: str, entity_id: Any) -> Any:
    info = entity_info(entity_type)
    try:
        pk = uuid.UUID(str(entity_id))
    except (TypeError, ValueError) as exc:
        raise ValidationError({"entity_id": "Expected a UUID."}) from exc
    obj = scope(actor, f"{info.module}.view", info.model.objects.filter(pk=pk)).first()
    if obj is None:
        raise Http404
    return obj
