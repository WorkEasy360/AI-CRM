from __future__ import annotations

from django.db import models
from django.db.models.functions import Lower

from apps.core.models import TenantModel

TAGGABLE_TYPES = ("contact", "company", "deal", "product")
COLOR_TOKENS = ("slate", "blue", "teal", "green", "amber", "red", "purple", "pink")


class Tag(TenantModel):
    name = models.CharField(max_length=40)
    color_token = models.CharField(max_length=16, default="slate")

    class Meta:
        constraints = [
            models.UniqueConstraint("organization", Lower("name"), name="uniq_tag_name_ci_per_org"),
        ]
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class TaggedItem(TenantModel):
    """A tag applied to a record. ``entity_id`` is validated against the scoped record in the service."""

    tag = models.ForeignKey(Tag, on_delete=models.CASCADE, related_name="items")
    entity_type = models.CharField(max_length=16)
    entity_id = models.UUIDField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["tag", "entity_type", "entity_id"], name="uniq_tagged_item"),
        ]
        indexes = [models.Index(fields=["organization", "entity_type", "entity_id"], name="taggeditem_org_entity_idx")]
