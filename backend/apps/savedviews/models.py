from __future__ import annotations

from typing import ClassVar

from django.db import models

from apps.core.models import TenantModel, VersionedModel


class SavedView(TenantModel, VersionedModel):
    """A saved List, Kanban, Sheet, Calendar or Chart view of one module.

    ``filters`` are the module's list filters (query parameters, validated by its FilterSet), ``columns``
    and the field keys in ``config`` come from the module schema. A view never widens what its viewer
    may see: it is applied through the viewer's own scope and field permissions every time it is opened.
    """

    OWNER_FIELD: ClassVar[str | None] = "owner"

    class Kind(models.TextChoices):
        LIST = "list", "List"
        KANBAN = "kanban", "Kanban"
        SHEET = "sheet", "Sheet"
        CALENDAR = "calendar", "Calendar"
        CHART = "chart", "Chart"

    class Visibility(models.TextChoices):
        PRIVATE = "private", "Only me"
        ORGANIZATION = "organization", "Everyone"
        TEAMS = "teams", "Selected teams"

    owner = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="+")
    entity_type = models.CharField(max_length=32)
    name = models.CharField(max_length=80)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    filters = models.JSONField(default=dict, blank=True)
    sort = models.CharField(max_length=64, blank=True)
    columns = models.JSONField(default=list, blank=True)
    config = models.JSONField(default=dict, blank=True)
    visibility = models.CharField(max_length=16, choices=Visibility.choices, default=Visibility.PRIVATE)
    team_ids = models.JSONField(default=list, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "owner", "entity_type", "name"], name="uniq_savedview_name_per_owner"
            )
        ]
        indexes = [models.Index(fields=["organization", "entity_type", "visibility"], name="savedview_org_entity_idx")]
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.entity_type}:{self.name}"


class SavedViewDefault(TenantModel):
    """The view a member opens a module with (one per member and module)."""

    OWNER_FIELD: ClassVar[str | None] = "membership"

    membership = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="+")
    entity_type = models.CharField(max_length=32)
    view = models.ForeignKey(SavedView, on_delete=models.CASCADE, related_name="defaults")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["membership", "entity_type"], name="uniq_savedview_default_per_member")
        ]
