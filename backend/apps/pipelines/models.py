from __future__ import annotations

from django.db import models

from apps.core.models import ArchivableModel, TenantModel, VersionedModel

STAGE_COLORS = ("slate", "blue", "teal", "green", "amber", "red", "purple", "pink")


class Pipeline(TenantModel, VersionedModel, ArchivableModel):
    name = models.CharField(max_length=80)
    position = models.PositiveIntegerField(default=0)
    is_default = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "name"], name="uniq_pipeline_name_per_org"),
            models.UniqueConstraint(
                fields=["organization"], condition=models.Q(is_default=True), name="uniq_default_pipeline_per_org"
            ),
        ]
        ordering = ["position", "created_at"]

    def __str__(self) -> str:
        return self.name


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
