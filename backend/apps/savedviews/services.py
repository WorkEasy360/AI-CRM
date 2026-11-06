"""Saved views: validation against the module schema, visibility, sharing and per-member defaults.

Who sees a view: its owner; everyone with access to the module when shared with the organization; the
members of the listed teams when shared with teams. Only the owner edits or deletes it. Sharing (anything
but private) needs ``views.share``. Opening a view never widens access: filters and columns are applied
with the viewer's own scope and field permissions, and ``for_viewer`` strips what the viewer cannot see.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Q, QuerySet
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.core import validators
from apps.core.concurrency import save_with_version
from apps.core.exceptions import ConflictError
from apps.crm import schema
from apps.savedviews.models import SavedView, SavedViewDefault

MAX_VIEWS_PER_MEMBER = 100
MAX_FILTERS = 30
MAX_TEAMS = 50
KINDS = frozenset(SavedView.Kind.values)


def visible(actor: Actor, entity_type: str | None = None) -> QuerySet:
    cond = Q(owner_id=actor.membership.pk) | Q(visibility=SavedView.Visibility.ORGANIZATION)
    for team_id in actor.team_ids:
        cond |= Q(visibility=SavedView.Visibility.TEAMS, team_ids__contains=[str(team_id)])
    qs = SavedView.objects.filter(cond).select_related("owner__user")
    if entity_type:
        qs = qs.filter(entity_type=entity_type)
    allowed = [m.entity_type for m in schema.modules() if actor.has(f"{m.module}.view")]
    return qs.filter(entity_type__in=allowed)


def _clean_filters(actor: Actor, entity_type: str, filters: Any, sort: str) -> tuple[dict[str, str], str]:
    if filters in (None, ""):
        filters = {}
    if not isinstance(filters, dict) or len(filters) > MAX_FILTERS:
        raise ValidationError({"filters": f"Filters must be an object with at most {MAX_FILTERS} entries."})
    cleaned = {str(k)[:64]: str(v)[:200] for k, v in filters.items() if v not in (None, "")}
    for reserved in ("cursor", "limit", "offset", "format"):
        cleaned.pop(reserved, None)
    module = schema.get(entity_type)
    binding = module.bind()
    params = dict(cleaned)
    if sort:
        params["sort"] = sort
    # The module's own FilterSet decides what is valid (unknown keys, hidden fields and bad values are 400).
    binding.filterset.apply(binding.spec.model.objects.none(), params, actor=actor)
    return cleaned, (sort or "")[:64]


def _clean_config(actor: Actor, entity_type: str, kind: str, config: Any) -> dict[str, Any]:
    if config in (None, ""):
        config = {}
    if not isinstance(config, dict):
        raise ValidationError({"config": "Expected an object."})
    fields = schema.field_map(actor, entity_type)
    out: dict[str, Any] = {}
    if kind == SavedView.Kind.KANBAN:
        if entity_type == "deal" and config.get("pipeline_id"):
            out["pipeline_id"] = str(_uuid(config["pipeline_id"], "config"))
        else:
            group_by = config.get("group_by")
            f = fields.get(group_by or "")
            if f is None or not f.groupable:
                raise ValidationError({"config": "Choose a field to group the board by."})
            out["group_by"] = f.key
    elif kind == SavedView.Kind.CALENDAR:
        f = fields.get(config.get("date_field") or "")
        if f is None or f.type not in schema.DATE_TYPES or f.custom:
            raise ValidationError({"config": "Choose the date field that places records on the calendar."})
        out["date_field"] = f.key
        out["include_activities"] = bool(config.get("include_activities", True))
    elif kind == SavedView.Kind.CHART:
        f = fields.get(config.get("group_by") or "")
        if f is None or not f.groupable:
            raise ValidationError({"config": "Choose a field to chart by."})
        measure = config.get("measure", "count")
        if measure not in {"count", "sum"}:
            raise ValidationError({"config": "Measure is count or sum."})
        out.update(group_by=f.key, measure=measure)
        if measure == "sum":
            summed = fields.get(config.get("field") or "")
            if summed is None or summed.type not in schema.NUMERIC_TYPES or summed.custom:
                raise ValidationError({"config": "Choose the number field to add up."})
            out["field"] = summed.key
    return out


def _uuid(raw: Any, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as exc:
        raise ValidationError({field: "Expected an id."}) from exc


def _clean_sharing(actor: Actor, visibility: str, team_ids: Any) -> tuple[str, list[str]]:
    from apps.teams.models import Team

    if visibility not in SavedView.Visibility.values:
        raise ValidationError({"visibility": "Unknown visibility."})
    if visibility != SavedView.Visibility.PRIVATE:
        check(actor, "views.share")
    if visibility != SavedView.Visibility.TEAMS:
        return visibility, []
    ids = [_uuid(t, "team_ids") for t in (team_ids or [])]
    if not ids or len(ids) > MAX_TEAMS:
        raise ValidationError({"team_ids": f"Choose 1 to {MAX_TEAMS} teams."})
    known = set(Team.objects.filter(pk__in=ids).values_list("pk", flat=True))  # tenant-scoped
    if len(known) != len(set(ids)):
        raise ValidationError({"team_ids": "Unknown team."})
    return visibility, sorted(str(t) for t in set(ids))


def _snapshot(view: SavedView) -> dict[str, Any]:
    return {
        "name": view.name,
        "kind": view.kind,
        "filters": view.filters,
        "sort": view.sort,
        "columns": view.columns,
        "config": view.config,
        "visibility": view.visibility,
        "team_ids": view.team_ids,
    }


@transaction.atomic
def create_view(actor: Actor, data: dict[str, Any], *, request: Any = None) -> SavedView:
    entity_type = data.get("entity_type", "")
    module = schema.get(entity_type)
    check(actor, f"{module.module}.view")
    kind = data.get("kind")
    if kind not in KINDS:
        raise ValidationError({"kind": "Choose list, kanban, sheet, calendar or chart."})
    if SavedView.objects.filter(owner_id=actor.membership.pk).count() >= MAX_VIEWS_PER_MEMBER:
        raise ValidationError({"name": f"At most {MAX_VIEWS_PER_MEMBER} saved views per member."})
    name = validators.clean_text(data.get("name"), max_length=80)
    if not name:
        raise ValidationError({"name": "Name is required."})
    filters, sort = _clean_filters(actor, entity_type, data.get("filters"), data.get("sort") or "")
    columns = schema.validate_keys(actor, entity_type, data.get("columns") or [], what="columns")[:80]
    config = _clean_config(actor, entity_type, kind, data.get("config"))
    visibility, team_ids = _clean_sharing(
        actor, data.get("visibility") or SavedView.Visibility.PRIVATE, data.get("team_ids")
    )
    try:
        with transaction.atomic():
            view = SavedView.objects.create(
                owner=actor.membership,
                entity_type=entity_type,
                name=name,
                kind=kind,
                filters=filters,
                sort=sort,
                columns=columns,
                config=config,
                visibility=visibility,
                team_ids=team_ids,
            )
    except IntegrityError as exc:
        raise ConflictError("You already have a view with this name.", code="view_name_taken") from exc
    audit.record("views.created", request=request, user=actor.user, resource=view, metadata=_snapshot(view))
    return view


def _owned(actor: Actor, view: SavedView) -> None:
    if view.owner_id != actor.membership.pk:
        raise PermissionDenied(detail="Only the owner of a view can change it.", code="permission_denied")


@transaction.atomic
def update_view(
    actor: Actor, view: SavedView, data: dict[str, Any], *, expected_version: int | None, request: Any = None
) -> SavedView:
    _owned(actor, view)
    before = _snapshot(view)
    changed: list[str] = []
    if "name" in data:
        name = validators.clean_text(data["name"], max_length=80)
        if not name:
            raise ValidationError({"name": "Name is required."})
        view.name = name
        changed.append("name")
    if "filters" in data or "sort" in data:
        view.filters, view.sort = _clean_filters(
            actor, view.entity_type, data.get("filters", view.filters), data.get("sort", view.sort) or ""
        )
        changed += ["filters", "sort"]
    if "columns" in data:
        view.columns = schema.validate_keys(actor, view.entity_type, data["columns"] or [], what="columns")[:80]
        changed.append("columns")
    if "config" in data:
        view.config = _clean_config(actor, view.entity_type, view.kind, data["config"])
        changed.append("config")
    if "visibility" in data or "team_ids" in data:
        view.visibility, view.team_ids = _clean_sharing(
            actor, data.get("visibility", view.visibility), data.get("team_ids", view.team_ids)
        )
        changed += ["visibility", "team_ids"]
    if not changed:
        return view
    try:
        with transaction.atomic():
            save_with_version(view, expected_version, changed)
    except IntegrityError as exc:
        raise ConflictError("You already have a view with this name.", code="view_name_taken") from exc
    audit.record(
        "views.updated",
        request=request,
        user=actor.user,
        resource=view,
        metadata={"before": before, "after": _snapshot(view)},
    )
    return view


@transaction.atomic
def delete_view(actor: Actor, view: SavedView, *, request: Any = None) -> None:
    _owned(actor, view)
    snapshot = {**_snapshot(view), "entity_type": view.entity_type}
    view_id = view.pk
    view.delete()
    audit.record(
        "views.deleted",
        request=request,
        user=actor.user,
        resource_type="savedview",
        resource_id=view_id,
        metadata=snapshot,
    )


@transaction.atomic
def set_default(actor: Actor, view: SavedView, *, request: Any = None) -> SavedViewDefault:
    """Make ``view`` (any view the actor can see) the one they open its module with."""
    if not visible(actor).filter(pk=view.pk).exists():
        raise ValidationError({"view": "Unknown view."})
    row, _ = SavedViewDefault.objects.update_or_create(
        membership=actor.membership, entity_type=view.entity_type, defaults={"view": view}
    )
    audit.record(
        "views.default_set",
        request=request,
        user=actor.user,
        resource=view,
        metadata={"entity_type": view.entity_type},
    )
    return row


@transaction.atomic
def clear_default(actor: Actor, entity_type: str, *, request: Any = None) -> None:
    schema.get(entity_type)
    deleted, _ = SavedViewDefault.objects.filter(membership=actor.membership, entity_type=entity_type).delete()
    if deleted:
        audit.record(
            "views.default_cleared",
            request=request,
            user=actor.user,
            resource_type="savedview",
            metadata={"entity_type": entity_type},
        )


def default_ids(actor: Actor) -> dict[str, uuid.UUID]:
    return dict(SavedViewDefault.objects.filter(membership=actor.membership).values_list("entity_type", "view_id"))


def for_viewer(actor: Actor, view: SavedView) -> dict[str, Any]:
    """The parts of a view this viewer can use: hidden columns and filters on hidden fields are dropped
    (and ``restricted`` says so), so a shared view opens for everyone without exposing anything."""
    from apps.core.api.filters import field_root

    fields = schema.field_map(actor, view.entity_type)
    columns = [c for c in view.columns if c in fields]
    binding = schema.get(view.entity_type).bind()
    filters: dict[str, str] = {}
    hidden = {f.key for f in schema.all_fields(view.entity_type)} - set(fields)
    for key, value in view.filters.items():
        name = key[7:-1] if key.startswith("filter[") else key
        spec = binding.filterset.filters.get(name)
        root = field_root(spec.lookup) if spec else None
        if name.startswith("custom.") and f"custom_data.{name[7:]}" in hidden:
            continue
        if root is not None and root in hidden:
            continue
        filters[key] = value
    config = dict(view.config)
    restricted = len(columns) != len(view.columns) or len(filters) != len(view.filters)
    for key in ("group_by", "date_field", "field"):
        if key in config and config[key] not in fields:
            config.pop(key)
            restricted = True
    sort = view.sort
    if sort and sort.lstrip("-") in hidden:
        sort, restricted = "", True
    return {"columns": columns, "filters": filters, "config": config, "sort": sort, "restricted": restricted}
