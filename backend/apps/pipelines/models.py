from __future__ import annotations

from django.db import models

from apps.core.models import ArchivableModel, TenantModel, VersionedModel

STAGE_COLORS = ("slate", "blue", "teal", "green", "amber", "red", "purple", "pink")


class Pipeline(TenantModel, VersionedModel, ArchivableModel):
    """A team pipeline, or (with ``parent``) a sub-pipeline: a variant with its own stage set.

    A sub-pipeline shares its parent's ``layout`` and access rules and is not counted against the
    edition's pipeline limit (DECISIONS M2.4). Variants are one level deep.
    """

    name = models.CharField(max_length=80)
    position = models.PositiveIntegerField(default=0)
    is_default = models.BooleanField(default=False)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.PROTECT, related_name="variants")
    # ``{"card_fields": [...], "form_fields": [...]}``: field keys from the deal schema (apps.crm.schema).
    layout = models.JSONField(default=dict, blank=True)
    # False: every member with deals.view sees it. True: only the teams/roles in ``access_rules``
    # (and pipeline managers). Only meaningful on a top-level pipeline; variants follow their parent.
    restricted = models.BooleanField(default=False)
    template_key = models.CharField(max_length=32, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "name"], name="uniq_pipeline_name_per_org"),
            models.UniqueConstraint(
                fields=["organization"], condition=models.Q(is_default=True), name="uniq_default_pipeline_per_org"
            ),
            models.CheckConstraint(
                condition=models.Q(parent__isnull=True) | models.Q(is_default=False),
                name="pipeline_variant_not_default",
            ),
        ]
        ordering = ["position", "created_at"]

    def __str__(self) -> str:
        return self.name

    @property
    def root_id(self):
        return self.parent_id or self.pk


class PipelineAccess(TenantModel):
    """One grant of a restricted pipeline: to a team or to a hierarchy role (exactly one of them)."""

    pipeline = models.ForeignKey(Pipeline, on_delete=models.CASCADE, related_name="access_rules")
    team = models.ForeignKey("teams.Team", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    hierarchy_role = models.ForeignKey(
        "authz.HierarchyRole", null=True, blank=True, on_delete=models.CASCADE, related_name="+"
    )

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(models.Q(team__isnull=False) & models.Q(hierarchy_role__isnull=True))
                | (models.Q(team__isnull=True) & models.Q(hierarchy_role__isnull=False)),
                name="pipelineaccess_one_grantee",
            ),
            models.UniqueConstraint(
                fields=["pipeline", "team"], condition=models.Q(team__isnull=False), name="uniq_pipelineaccess_team"
            ),
            models.UniqueConstraint(
                fields=["pipeline", "hierarchy_role"],
                condition=models.Q(hierarchy_role__isnull=False),
                name="uniq_pipelineaccess_role",
            ),
        ]


class PipelineStage(TenantModel, ArchivableModel):
    class Kind(models.TextChoices):
        OPEN = "open", "Open"
        WON = "won", "Won"
        LOST = "lost", "Lost"

    pipeline = models.ForeignKey(Pipeline, on_delete=models.CASCADE, related_name="stages")
    name = models.CharField(max_length=80)
    position = models.PositiveIntegerField(default=0)
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.OPEN)
    default_probability = models.PositiveSmallIntegerField(default=10)
    description = models.CharField(max_length=255, blank=True)
    color_token = models.CharField(max_length=16, default="slate")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["pipeline", "name"], name="uniq_stage_name_per_pipeline"),
            models.UniqueConstraint(
                fields=["pipeline", "position"],
                name="uniq_stage_position_per_pipeline",
                deferrable=models.Deferrable.DEFERRED,
            ),
            models.CheckConstraint(condition=models.Q(default_probability__lte=100), name="stage_probability_range"),
        ]
        ordering = ["position"]

    def __str__(self) -> str:
        return f"{self.pipeline_id}:{self.name}"
