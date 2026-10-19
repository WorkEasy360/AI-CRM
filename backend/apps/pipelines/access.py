"""Per-pipeline access (team pipelines restricted to teams or hierarchy roles).

A restricted top-level pipeline, its sub-pipelines and their deals are invisible to members outside its
grants. Pipeline managers (``pipelines.manage``) always see every pipeline, so an organization cannot lock
its admins out. The rule is registered with ``authz.service.register_visibility_rule`` and therefore
applies wherever ``scope()``/``check()`` already run: lists, detail, board, search, exports, aggregates.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.db.models import Q, QuerySet

_CACHE_ATTR = "_denied_pipeline_ids"


def denied_pipeline_ids(actor: Any) -> frozenset[uuid.UUID]:
    """Pipelines (top-level and variants) this actor may not see. Empty for almost everyone."""
    if actor is None:
        return frozenset()
    cached = actor.__dict__.get(_CACHE_ATTR)
    if cached is not None:
        return cached
    denied = _compute(actor)
    actor.__dict__[_CACHE_ATTR] = denied  # Actor is frozen; cached like its cached_property members
    return denied


def _compute(actor: Any) -> frozenset[uuid.UUID]:
    from apps.pipelines.models import Pipeline, PipelineAccess

    if actor.has("pipelines.manage"):
        return frozenset()
    restricted = set(Pipeline.objects.filter(restricted=True, parent__isnull=True).values_list("pk", flat=True))
    if not restricted:
        return frozenset()
    grant = Q(team_id__in=actor.team_ids)
    role_id = getattr(actor.membership, "hierarchy_role_id", None)
    if role_id is not None:
        grant |= Q(hierarchy_role_id=role_id)
    granted = set(
        PipelineAccess.objects.filter(grant, pipeline_id__in=restricted).values_list("pipeline_id", flat=True)
    )
    denied_roots = restricted - granted
    if not denied_roots:
        return frozenset()
    variants = Pipeline.objects.filter(parent_id__in=denied_roots).values_list("pk", flat=True)
    return frozenset(denied_roots | set(variants))


def forget(actor: Any) -> None:
    actor.__dict__.pop(_CACHE_ATTR, None)


def can_access(actor: Any, pipeline_id: uuid.UUID | None) -> bool:
    return pipeline_id is None or pipeline_id not in denied_pipeline_ids(actor)


def register() -> None:
    from apps.authz.service import register_visibility_rule
    from apps.deals.models import Deal
    from apps.pipelines.models import Pipeline, PipelineStage

    def _exclude(lookup: str):
        def narrow(actor: Any, qs: QuerySet) -> QuerySet:
            denied = denied_pipeline_ids(actor)
            return qs.exclude(**{f"{lookup}__in": denied}) if denied else qs

        return narrow

    register_visibility_rule(Deal, queryset=_exclude("pipeline_id"), obj=lambda a, d: can_access(a, d.pipeline_id))
    register_visibility_rule(Pipeline, queryset=_exclude("pk"), obj=lambda a, p: can_access(a, p.pk))
    register_visibility_rule(
        PipelineStage, queryset=_exclude("pipeline_id"), obj=lambda a, s: can_access(a, s.pipeline_id)
    )
