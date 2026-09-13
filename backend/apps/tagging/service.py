from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable
from typing import Any

from django.db import IntegrityError, transaction
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.core import validators
from apps.core.exceptions import ConflictError
from apps.tagging.models import COLOR_TOKENS, TAGGABLE_TYPES, Tag, TaggedItem


def _clean_name(name: str) -> str:
    name = validators.clean_text(name, max_length=40)
    if not name:
        raise ValidationError({"name": "Name is required."})
    return name


def _clean_color(color: str | None) -> str:
    color = (color or "slate").strip().lower()
    if color not in COLOR_TOKENS:
        raise ValidationError({"color_token": f"Allowed colours: {', '.join(COLOR_TOKENS)}."})
    return color


@transaction.atomic
def create_tag(actor: Actor, *, name: str, color_token: str | None = None, request: Any = None) -> Tag:
    check(actor, "tags.manage")
    name = _clean_name(name)
    color = _clean_color(color_token)
    if Tag.objects.filter(name__iexact=name).exists():
        raise ConflictError("A tag with this name already exists.", code="tag_name_taken")
    try:
        tag = Tag.objects.create(name=name, color_token=color)
    except IntegrityError as exc:
        raise ConflictError("A tag with this name already exists.", code="tag_name_taken") from exc
    audit.record("tags.created", request=request, user=actor.user, resource=tag, metadata={"name": name})
    return tag


@transaction.atomic
def update_tag(
    actor: Actor, tag: Tag, *, name: str | None = None, color_token: str | None = None, request: Any = None
) -> Tag:
    check(actor, "tags.manage", tag)
    changed: dict[str, Any] = {}
    if name is not None:
        name = _clean_name(name)
        if name.lower() != tag.name.lower() and Tag.objects.filter(name__iexact=name).exists():
            raise ConflictError("A tag with this name already exists.", code="tag_name_taken")
        tag.name = changed["name"] = name
    if color_token is not None:
        tag.color_token = changed["color_token"] = _clean_color(color_token)
    if changed:
        tag.save(update_fields=[*changed.keys(), "updated_at"])
        audit.record("tags.updated", request=request, user=actor.user, resource=tag, metadata=changed)
    return tag


@transaction.atomic
def delete_tag(actor: Actor, tag: Tag, *, request: Any = None) -> None:
    check(actor, "tags.manage", tag)
    tag_id, name = tag.pk, tag.name
    tag.delete()
    audit.record(
        "tags.deleted",
        request=request,
        user=actor.user,
        resource_type="tag",
        resource_id=tag_id,
        metadata={"name": name},
    )


def tags_for(entity_type: str, entity_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, list[Tag]]:
    """Batch-load tags for a page of records (no N+1)."""
    ids = list(entity_ids)
    if not ids:
        return {}
    out: dict[uuid.UUID, list[Tag]] = defaultdict(list)
    items = (
        TaggedItem.objects.filter(entity_type=entity_type, entity_id__in=ids)
        .select_related("tag")
        .order_by("tag__name")
    )
    for item in items:
        out[item.entity_id].append(item.tag)
    return out


def set_tags(
    actor: Actor, *, record: Any, entity_type: str, permission: str, tag_ids: list[uuid.UUID], request: Any = None
):
    """Replace the record's tags. Requires the record's update permission; tag ids must be tenant tags."""
    if entity_type not in TAGGABLE_TYPES:
        raise ValidationError({"entity_type": "Not taggable."})
    check(actor, permission, record)
    tags = {t.pk: t for t in Tag.objects.filter(pk__in=tag_ids)}
    missing = [str(t) for t in tag_ids if t not in tags]
    if missing:
        raise ValidationError({"tag_ids": "Unknown tag id."})
    with transaction.atomic():
        current = set(
            TaggedItem.objects.filter(entity_type=entity_type, entity_id=record.pk).values_list("tag_id", flat=True)
        )
        wanted = set(tags)
        TaggedItem.objects.filter(entity_type=entity_type, entity_id=record.pk, tag_id__in=current - wanted).delete()
        TaggedItem.objects.bulk_create(
            [
                TaggedItem(
                    tag=tags[t], entity_type=entity_type, entity_id=record.pk, organization_id=record.organization_id
                )
                for t in wanted - current
            ]
        )
        if current != wanted:
            audit.record(
                "tags.applied",
                request=request,
                user=actor.user,
                resource=record,
                metadata={
                    "added": sorted(str(t) for t in wanted - current),
                    "removed": sorted(str(t) for t in current - wanted),
                },
            )
    return [tags[t] for t in sorted(wanted, key=lambda t: tags[t].name.lower())]


def add_tag_bulk(entity_type: str, records: Iterable[Any], tag: Tag) -> int:
    rows = []
    for r in records:
        rows.append(TaggedItem(tag=tag, entity_type=entity_type, entity_id=r.pk, organization_id=r.organization_id))
    created = TaggedItem.objects.bulk_create(rows, ignore_conflicts=True)
    return len(created)
