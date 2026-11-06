"""Favourites: a member's starred contacts and companies, and the list filters that use them and tags."""

from __future__ import annotations

import uuid
from typing import Any

from django.db.models import Exists, OuterRef, QuerySet
from rest_framework.exceptions import ValidationError

from apps.authz.actor import Actor
from apps.core.tenancy.context import get_context
from apps.notes.registry import resolve_viewable
from apps.tagging.models import FAVORITE_TYPES, Favorite, TaggedItem


def _member_id() -> Any:
    ctx = get_context()
    return getattr(ctx, "membership_id", None)


def is_favorite_annotation(entity_type: str) -> Exists:
    """``is_favorite`` for the signed-in member (false outside a member context)."""
    return Exists(
        Favorite.objects.filter(membership_id=_member_id(), entity_type=entity_type, entity_id=OuterRef("pk"))
    )


def favorite_filter(entity_type: str):
    def apply(qs: QuerySet, key: str, raw: Any) -> QuerySet:
        mine = Favorite.objects.filter(membership_id=_member_id(), entity_type=entity_type).values("entity_id")
        wanted = str(raw).strip().lower() in {"1", "true", "yes"}
        return qs.filter(pk__in=mine) if wanted else qs.exclude(pk__in=mine)

    return apply


def tag_filter(entity_type: str):
    """``?tag=<id>``: records carrying that tag (a subquery, so each record is listed once)."""

    def apply(qs: QuerySet, key: str, raw: Any) -> QuerySet:
        try:
            tag_id = uuid.UUID(str(raw).strip())
        except ValueError as exc:
            raise ValidationError({key: "Expected a UUID."}) from exc
        return qs.filter(pk__in=TaggedItem.objects.filter(entity_type=entity_type, tag_id=tag_id).values("entity_id"))

    return apply


def tagged_annotation(entity_type: str) -> Exists:
    return Exists(TaggedItem.objects.filter(entity_type=entity_type, entity_id=OuterRef("pk")))


def set_favorite(actor: Actor, entity_type: str, entity_id: Any, favorite: bool) -> bool:
    """Star or unstar a record the actor may view (anything else answers 404, as the record does)."""
    if entity_type not in FAVORITE_TYPES:
        raise ValidationError({"entity_type": "Only contacts and companies can be favourites."})
    record = resolve_viewable(actor, entity_type, entity_id)
    if favorite:
        Favorite.objects.get_or_create(membership=actor.membership, entity_type=entity_type, entity_id=record.pk)
    else:
        Favorite.objects.filter(membership=actor.membership, entity_type=entity_type, entity_id=record.pk).delete()
    return favorite
