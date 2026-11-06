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
from apps.billing import entitlements
from apps.core import validators
from apps.core.concurrency import save_with_version
from apps.core.exceptions import ConflictError, DomainError
from apps.pipelines.models import STAGE_COLORS, Pipeline, PipelineAccess, PipelineStage
from apps.pipelines.templates import DEFAULT_TEMPLATE, TEMPLATES

MAX_PIPELINES = 20
MAX_STAGES = 30
MAX_VARIANTS_PER_PIPELINE = 10
MAX_ACCESS_GRANTS = 50
LAYOUT_LIMITS = {"card_fields": 8, "form_fields": 60}

DEFAULT_STAGES: list[dict[str, Any]] = TEMPLATES[DEFAULT_TEMPLATE].stage_specs()


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
    pipeline = Pipeline.objects.create(name=name, position=0, is_default=True, template_key=DEFAULT_TEMPLATE)
    PipelineStage.objects.bulk_create(
        [
            PipelineStage(pipeline=pipeline, position=i, organization_id=pipeline.organization_id, **s)
            for i, s in enumerate(DEFAULT_STAGES)
        ]
    )
    return pipeline


def clean_layout(layout: Any) -> dict[str, list[str]]:
    """``{"card_fields": [...], "form_fields": [...]}`` of deal field keys known to the schema registry."""
    from apps.crm import schema

    if layout in (None, {}):
        return {}
    if not isinstance(layout, dict) or set(layout) - set(LAYOUT_LIMITS):
        raise ValidationError({"layout": f"Allowed keys: {', '.join(LAYOUT_LIMITS)}."})
    cleaned: dict[str, list[str]] = {}
    for key, limit in LAYOUT_LIMITS.items():
        if key not in layout:
            continue
        values = layout[key]
        if not isinstance(values, list) or len(values) > limit:
            raise ValidationError({"layout": f"{key} must be a list of at most {limit} field keys."})
        cleaned[key] = schema.validate_keys(None, "deal", values, what="layout")
    return cleaned


def templates() -> list[dict[str, Any]]:
    return [
        {"key": t.key, "name": t.name, "description": t.description, "stages": t.stage_specs()}
        for t in TEMPLATES.values()
    ]


@transaction.atomic
def create_pipeline(
    actor: Actor,
    *,
    name: str,
    stages: list[dict[str, Any]] | None = None,
    template: str | None = None,
    parent: Pipeline | None = None,
    layout: Any = None,
    restricted: bool = False,
    request: Any = None,
) -> Pipeline:
    """A team pipeline, or with ``parent`` a sub-pipeline (variant) of one.

    Stages come from ``stages``, else from ``template``, else from the default template. A variant shares
    its parent's layout and access rules and does not count against the edition's pipeline limit.
    """
    check(actor, "pipelines.manage")
    name = _clean_name(name)
    if Pipeline.objects.filter(name__iexact=name).exists():
        raise ConflictError("A pipeline with this name already exists.", code="pipeline_name_taken")
    if template is not None and template not in TEMPLATES:
        raise ValidationError({"template": "Unknown template."})
    if parent is not None:
        if parent.parent_id is not None:
            raise ValidationError({"parent_id": "A sub-pipeline cannot have sub-pipelines of its own."})
        if parent.archived_at is not None:
            raise ValidationError({"parent_id": "The parent pipeline is archived."})
        Pipeline.objects.select_for_update().filter(pk=parent.pk).first()
        if parent.variants.filter(archived_at__isnull=True).count() >= MAX_VARIANTS_PER_PIPELINE:
            raise DomainError(
                f"At most {MAX_VARIANTS_PER_PIPELINE} sub-pipelines per pipeline.", code="pipeline_variant_limit"
            )
        if layout not in (None, {}) or restricted:
            raise ValidationError({"parent_id": "A sub-pipeline uses its parent's layout and access."})
    else:
        if Pipeline.objects.filter(archived_at__isnull=True, parent__isnull=True).count() >= MAX_PIPELINES:
            raise DomainError(f"At most {MAX_PIPELINES} pipelines.", code="pipeline_limit")
        entitlements.check_capacity(actor.organization, "pipelines")
    is_default = parent is None and not Pipeline.objects.filter(is_default=True).exists()
    position = Pipeline.objects.count()
    pipeline = Pipeline.objects.create(
        name=name,
        position=position,
        is_default=is_default,
        parent=parent,
        layout=clean_layout(layout) if parent is None else {},
        restricted=bool(restricted) and parent is None,
        template_key=template or ("" if stages else DEFAULT_TEMPLATE),
    )
    spec = stages if stages else TEMPLATES[template or DEFAULT_TEMPLATE].stage_specs()
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
    audit.record(
        "pipelines.created",
        request=request,
        user=actor.user,
        resource=pipeline,
        metadata={
            "name": name,
            "parent_id": str(parent.pk) if parent else None,
            "template": pipeline.template_key,
            "restricted": pipeline.restricted,
        },
    )
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
        if pipeline.parent_id is not None:
            raise DomainError("A sub-pipeline cannot be the default.", code="pipeline_variant_default")
        if pipeline.archived_at is not None:
            raise DomainError("An archived pipeline cannot be the default.", code="pipeline_archived")
        Pipeline.objects.filter(is_default=True).update(is_default=False)
        pipeline.is_default = True
        changed.append("is_default")
    if changes.get("position") is not None:
        pipeline.position = int(changes["position"])
        changed.append("position")
    if changes.get("layout") is not None:
        if pipeline.parent_id is not None:
            raise ValidationError({"layout": "A sub-pipeline uses its parent's layout."})
        pipeline.layout = clean_layout(changes["layout"])
        changed.append("layout")
    if changes.get("restricted") is not None and bool(changes["restricted"]) != pipeline.restricted:
        if pipeline.parent_id is not None:
            raise ValidationError({"restricted": "A sub-pipeline follows its parent's access."})
        pipeline.restricted = bool(changes["restricted"])
        changed.append("restricted")
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
    if pipeline.variants.filter(archived_at__isnull=True).exists():
        raise DomainError("Archive its sub-pipelines first.", code="pipeline_has_variants", status_code=409)
    pipeline.archived_at = timezone.now()
    save_with_version(pipeline, None, ["archived_at"])
    audit.record("pipelines.archived", request=request, user=actor.user, resource=pipeline)
    return pipeline


@transaction.atomic
def set_access(
    actor: Actor,
    pipeline: Pipeline,
    *,
    team_ids: list[uuid.UUID],
    hierarchy_role_ids: list[uuid.UUID],
    request: Any = None,
) -> list[PipelineAccess]:
    """Replace who may use a restricted pipeline. Grants live on the top-level pipeline only."""
    from apps.authz.models import HierarchyRole
    from apps.teams.models import Team

    check(actor, "pipelines.manage", pipeline)
    if pipeline.parent_id is not None:
        raise ValidationError({"pipeline": "A sub-pipeline follows its parent's access."})
    team_ids = list(dict.fromkeys(team_ids))
    role_ids = list(dict.fromkeys(hierarchy_role_ids))
    if len(team_ids) + len(role_ids) > MAX_ACCESS_GRANTS:
        raise ValidationError({"team_ids": f"At most {MAX_ACCESS_GRANTS} grants."})
    # Tenant-scoped lookups: an id from another organization is simply unknown here.
    teams = {t.pk: t for t in Team.objects.filter(pk__in=team_ids)}
    roles = {r.pk: r for r in HierarchyRole.objects.filter(pk__in=role_ids)}
    if len(teams) != len(team_ids):
        raise ValidationError({"team_ids": "Unknown team."})
    if len(roles) != len(role_ids):
        raise ValidationError({"hierarchy_role_ids": "Unknown role."})
    existing = PipelineAccess.objects.filter(pipeline=pipeline)
    before = {
        "team_ids": sorted(str(t) for t in existing.filter(team__isnull=False).values_list("team_id", flat=True)),
        "hierarchy_role_ids": sorted(
            str(r) for r in existing.filter(hierarchy_role__isnull=False).values_list("hierarchy_role_id", flat=True)
        ),
    }
    existing.delete()
    rows = [
        PipelineAccess(pipeline=pipeline, team=teams[t], organization_id=pipeline.organization_id) for t in team_ids
    ]
    rows += [
        PipelineAccess(pipeline=pipeline, hierarchy_role=roles[r], organization_id=pipeline.organization_id)
        for r in role_ids
    ]
    PipelineAccess.objects.bulk_create(rows)
    audit.record(
        "pipelines.access_changed",
        request=request,
        user=actor.user,
        resource=pipeline,
        metadata={
            "before": before,
            "after": {"team_ids": sorted(map(str, team_ids)), "hierarchy_role_ids": sorted(map(str, role_ids))},
        },
    )
    return rows


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
