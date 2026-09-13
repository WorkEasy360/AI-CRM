"""Pipeline and stage management. Stage reordering is one transaction over a deferrable unique index."""

from __future__ import annotations

import uuid
from typing import Any

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.core import validators
from apps.core.concurrency import save_with_version
from apps.core.exceptions import ConflictError, DomainError
from apps.pipelines.models import STAGE_COLORS, Pipeline, PipelineStage

MAX_PIPELINES = 20
MAX_STAGES = 30


def _stage(name: str, kind: str, probability: int, color: str) -> dict[str, Any]:
    return {"name": name, "kind": kind, "default_probability": probability, "color_token": color}


DEFAULT_STAGES: list[dict[str, Any]] = [
    _stage("Qualification", "open", 10, "slate"),
    _stage("Needs analysis", "open", 25, "blue"),
    _stage("Proposal", "open", 50, "teal"),
    _stage("Negotiation", "open", 75, "amber"),
    _stage("Closed won", "won", 100, "green"),
    _stage("Closed lost", "lost", 0, "red"),
]


def _clean_name(name: str, *, field: str = "name", max_length: int = 80) -> str:
    value = validators.clean_text(name, max_length=max_length)
    if not value:
        raise ValidationError({field: "Name is required."})
    return value


def _clean_color(color: str | None) -> str:
    color = (color or "slate").strip().lower()
    if color not in STAGE_COLORS:
        raise ValidationError({"color_token": f"Allowed colours: {', '.join(STAGE_COLORS)}."})
    return color


def _clean_probability(value: Any, kind: str) -> int:
    if kind == PipelineStage.Kind.WON:
        return 100
    if kind == PipelineStage.Kind.LOST:
        return 0
    try:
        p = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError({"default_probability": "Expected 0-100."}) from exc
    if not 0 <= p <= 100:
        raise ValidationError({"default_probability": "Expected 0-100."})
    return p


def _assert_terminal_stages(pipeline: Pipeline) -> None:
    kinds = set(pipeline.stages.filter(archived_at__isnull=True).values_list("kind", flat=True))
    if PipelineStage.Kind.WON not in kinds or PipelineStage.Kind.LOST not in kinds:
        raise DomainError(
            "A pipeline needs at least one won stage and one lost stage.", code="pipeline_terminal_stages"
        )
    if PipelineStage.Kind.OPEN not in kinds:
        raise DomainError("A pipeline needs at least one open stage.", code="pipeline_open_stage")


# ----------------------------------------------------------------------------- pipelines


def ensure_default_pipeline(*, name: str = "Sales pipeline") -> Pipeline:
    """Create the default pipeline for an organization if none exists (called on organization creation)."""
    existing = Pipeline.objects.filter(archived_at__isnull=True).first()
    if existing is not None:
        return existing
    pipeline = Pipeline.objects.create(name=name, position=0, is_default=True)
    PipelineStage.objects.bulk_create(
        [
            PipelineStage(pipeline=pipeline, position=i, organization_id=pipeline.organization_id, **s)
            for i, s in enumerate(DEFAULT_STAGES)
        ]
    )
    return pipeline


@transaction.atomic
def create_pipeline(
    actor: Actor, *, name: str, stages: list[dict[str, Any]] | None = None, request: Any = None
) -> Pipeline:
    check(actor, "pipelines.manage")
    name = _clean_name(name)
    if Pipeline.objects.filter(name__iexact=name).exists():
        raise ConflictError("A pipeline with this name already exists.", code="pipeline_name_taken")
    if Pipeline.objects.filter(archived_at__isnull=True).count() >= MAX_PIPELINES:
        raise DomainError(f"At most {MAX_PIPELINES} pipelines.", code="pipeline_limit")
    is_default = not Pipeline.objects.filter(is_default=True).exists()
    position = Pipeline.objects.count()
    pipeline = Pipeline.objects.create(name=name, position=position, is_default=is_default)
    spec = stages if stages else DEFAULT_STAGES
    if len(spec) > MAX_STAGES:
        raise ValidationError({"stages": f"At most {MAX_STAGES} stages."})
    rows = []
    names: set[str] = set()
    for i, s in enumerate(spec):
        kind = s.get("kind", "open")
        if kind not in PipelineStage.Kind.values:
            raise ValidationError({"stages": "Unknown stage kind."})
        stage_name = _clean_name(s.get("name", ""), field="stages")
        if stage_name.lower() in names:
            raise ValidationError({"stages": f"Duplicate stage name '{stage_name}'."})
        names.add(stage_name.lower())
        rows.append(
            PipelineStage(
                pipeline=pipeline,
                organization_id=pipeline.organization_id,
                name=stage_name,
                position=i,
                kind=kind,
                default_probability=_clean_probability(s.get("default_probability", 10), kind),
                description=validators.clean_text(s.get("description", ""), max_length=255),
                color_token=_clean_color(s.get("color_token")),
            )
        )
    PipelineStage.objects.bulk_create(rows)
    _assert_terminal_stages(pipeline)
    audit.record("pipelines.created", request=request, user=actor.user, resource=pipeline, metadata={"name": name})
    return pipeline


@transaction.atomic
def update_pipeline(
    actor: Actor, pipeline: Pipeline, *, expected_version: int | None, request: Any = None, **changes: Any
) -> Pipeline:
    check(actor, "pipelines.manage", pipeline)
    changed: list[str] = []
    if changes.get("name") is not None:
        name = _clean_name(changes["name"])
        if name.lower() != pipeline.name.lower() and Pipeline.objects.filter(name__iexact=name).exists():
            raise ConflictError("A pipeline with this name already exists.", code="pipeline_name_taken")
        pipeline.name = name
        changed.append("name")
    if changes.get("is_default") is True and not pipeline.is_default:
        if pipeline.archived_at is not None:
            raise DomainError("An archived pipeline cannot be the default.", code="pipeline_archived")
        Pipeline.objects.filter(is_default=True).update(is_default=False)
        pipeline.is_default = True
        changed.append("is_default")
    if changes.get("position") is not None:
        pipeline.position = int(changes["position"])
        changed.append("position")
    if changed:
        save_with_version(pipeline, expected_version, changed)
        audit.record(
            "pipelines.updated", request=request, user=actor.user, resource=pipeline, metadata={"fields": changed}
        )
    return pipeline


@transaction.atomic
def archive_pipeline(actor: Actor, pipeline: Pipeline, *, request: Any = None) -> Pipeline:
    from apps.deals.models import Deal

    check(actor, "pipelines.manage", pipeline)
    if pipeline.archived_at is not None:
        return pipeline
    if Deal.objects.filter(pipeline=pipeline, archived_at__isnull=True, status=Deal.Status.OPEN).exists():
        raise DomainError(
            "Move or close the open deals in this pipeline first.", code="pipeline_has_open_deals", status_code=409
        )
    if pipeline.is_default:
        raise DomainError("Make another pipeline the default first.", code="pipeline_is_default", status_code=409)
    pipeline.archived_at = timezone.now()
    save_with_version(pipeline, None, ["archived_at"])
    audit.record("pipelines.archived", request=request, user=actor.user, resource=pipeline)
    return pipeline


# ----------------------------------------------------------------------------- stages


@transaction.atomic
def create_stage(
    actor: Actor,
    pipeline: Pipeline,
    *,
    name: str,
    kind: str = "open",
    default_probability: Any = 10,
    description: str = "",
    color_token: str | None = None,
    request: Any = None,
) -> PipelineStage:
    check(actor, "pipelines.manage", pipeline)
    if kind not in PipelineStage.Kind.values:
        raise ValidationError({"kind": "Unknown stage kind."})
    name = _clean_name(name)
    stages = PipelineStage.objects.select_for_update().filter(pipeline=pipeline)
    if stages.filter(name__iexact=name).exists():
        raise ConflictError("A stage with this name already exists.", code="stage_name_taken")
    if stages.filter(archived_at__isnull=True).count() >= MAX_STAGES:
        raise DomainError(f"At most {MAX_STAGES} stages per pipeline.", code="stage_limit")
    position = (stages.order_by("-position").values_list("position", flat=True).first() or 0) + 1
    stage = PipelineStage.objects.create(
        pipeline=pipeline,
        name=name,
        position=position,
        kind=kind,
        default_probability=_clean_probability(default_probability, kind),
        description=validators.clean_text(description, max_length=255),
        color_token=_clean_color(color_token),
    )
    audit.record(
        "pipelines.stage_created",
        request=request,
        user=actor.user,
        resource=stage,
        metadata={"name": name, "pipeline_id": str(pipeline.pk)},
    )
    return stage


@transaction.atomic
def update_stage(actor: Actor, stage: PipelineStage, *, request: Any = None, **changes: Any) -> PipelineStage:
    check(actor, "pipelines.manage", stage)
    changed: dict[str, Any] = {}
    if changes.get("name") is not None:
        name = _clean_name(changes["name"])
        if (
            name.lower() != stage.name.lower()
            and PipelineStage.objects.filter(pipeline_id=stage.pipeline_id, name__iexact=name).exists()
        ):
            raise ConflictError("A stage with this name already exists.", code="stage_name_taken")
        stage.name = changed["name"] = name
    if changes.get("kind") is not None and changes["kind"] != stage.kind:
        if changes["kind"] not in PipelineStage.Kind.values:
            raise ValidationError({"kind": "Unknown stage kind."})
        stage.kind = changed["kind"] = changes["kind"]
        stage.default_probability = changed["default_probability"] = _clean_probability(
            changes.get("default_probability", stage.default_probability), stage.kind
        )
    elif changes.get("default_probability") is not None:
        stage.default_probability = changed["default_probability"] = _clean_probability(
            changes["default_probability"], stage.kind
        )
    if changes.get("description") is not None:
        stage.description = changed["description"] = validators.clean_text(changes["description"], max_length=255)
    if changes.get("color_token") is not None:
        stage.color_token = changed["color_token"] = _clean_color(changes["color_token"])
    if changed:
        stage.save(update_fields=[*changed.keys(), "updated_at"])
        _assert_terminal_stages(stage.pipeline)
        audit.record("pipelines.stage_updated", request=request, user=actor.user, resource=stage, metadata=changed)
    return stage


@transaction.atomic
def archive_stage(actor: Actor, stage: PipelineStage, *, request: Any = None) -> PipelineStage:
    from apps.deals.models import Deal

    check(actor, "pipelines.manage", stage)
    if stage.archived_at is not None:
        return stage
    if Deal.objects.filter(stage=stage, archived_at__isnull=True).exists():
        raise DomainError("Move the deals in this stage first.", code="stage_has_deals", status_code=409)
    stage.archived_at = timezone.now()
    stage.save(update_fields=["archived_at", "updated_at"])
    _assert_terminal_stages(stage.pipeline)
    audit.record("pipelines.stage_archived", request=request, user=actor.user, resource=stage)
    return stage


@transaction.atomic
def reorder_stages(
    actor: Actor, pipeline: Pipeline, *, stage_ids: list[uuid.UUID], request: Any = None
) -> list[PipelineStage]:
    """Assign positions in the given order. The unique (pipeline, position) index is deferred, so the
    swap happens in one statement batch without transient collisions."""
    check(actor, "pipelines.manage", pipeline)
    stages = {
        s.pk: s for s in PipelineStage.objects.select_for_update().filter(pipeline=pipeline, archived_at__isnull=True)
    }
    if set(stage_ids) != set(stages) or len(stage_ids) != len(stages):
        raise ValidationError({"stage_ids": "Provide every active stage of this pipeline exactly once."})
    for position, sid in enumerate(stage_ids):
        stage = stages[sid]
        if stage.position != position:
            stage.position = position
            stage.save(update_fields=["position", "updated_at"])
    audit.record(
        "pipelines.stages_reordered",
        request=request,
        user=actor.user,
        resource=pipeline,
        metadata={"order": [str(s) for s in stage_ids]},
    )
    return [stages[s] for s in stage_ids]
