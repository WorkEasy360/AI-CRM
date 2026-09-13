"""Lifecycle transitions for contacts and companies: validated, historised, audited.

``set_stage`` is the only writer of ``lifecycle_stage``. Contact/company updates route through it, and
the deal service calls ``promote_on_won`` when a deal closes won so the customer relationship is
recorded without anyone having to remember to update the status by hand.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.lifecycle.models import LifecycleHistory
from apps.lifecycle.stages import LIFECYCLE_STAGES, STAGE_RANK, LifecycleStage

ENTITY_MODULES = {"contact": "contacts", "company": "companies"}


def clean_stage(value: Any) -> str:
    value = str(value or "").strip().lower()
    if value not in LIFECYCLE_STAGES:
        raise ValidationError({"lifecycle_stage": f"Allowed values: {', '.join(LIFECYCLE_STAGES)}."})
    return value


def _entity_type(record: Any) -> str:
    name = type(record).__name__.lower()
    if name not in ENTITY_MODULES:
        raise ValueError(f"{name} has no lifecycle")
    return name


@transaction.atomic
def set_stage(
    actor: Actor | None,
    record: Any,
    stage: str,
    *,
    source: str = LifecycleHistory.Source.USER,
    reason: str = "",
    request: Any = None,
) -> bool:
    """Move ``record`` to ``stage``. Returns True when something changed.

    Does not bump ``version``: callers that expose optimistic concurrency do that themselves.
    """
    stage = clean_stage(stage)
    current = record.lifecycle_stage
    if current == stage:
        return False
    now = timezone.now()
    entity_type = _entity_type(record)
    type(record).objects.filter(pk=record.pk).update(lifecycle_stage=stage, lifecycle_changed_at=now, updated_at=now)
    record.lifecycle_stage = stage
    record.lifecycle_changed_at = now
    LifecycleHistory.objects.create(
        entity_type=entity_type,
        entity_id=record.pk,
        from_stage=current or "",
        to_stage=stage,
        changed_by=actor.membership if actor else None,
        changed_at=now,
        source=source,
        reason=reason[:255],
    )
    audit.record(
        "lifecycle.changed",
        request=request,
        user=actor.user if actor else None,
        resource=record,
        resource_type=entity_type,
        metadata={"from": current, "to": stage, "source": source, "reason": reason[:255]},
    )
    return True


def record_initial_stage(actor: Actor, record: Any) -> None:
    """A record created directly into a later stage gets a history row (from "" to that stage)."""
    LifecycleHistory.objects.create(
        entity_type=_entity_type(record),
        entity_id=record.pk,
        from_stage="",
        to_stage=record.lifecycle_stage,
        changed_by=actor.membership,
        changed_at=record.created_at,
    )


def promote_on_won(actor: Actor, records: list[Any], *, deal_name: str, request: Any = None) -> int:
    """A closed-won deal makes its contacts and company customers (never demotes anyone)."""
    changed = 0
    for record in records:
        if record is None or getattr(record, "archived_at", None) is not None:
            continue
        if STAGE_RANK.get(record.lifecycle_stage, 0) >= STAGE_RANK[LifecycleStage.CUSTOMER]:
            continue
        if set_stage(
            actor,
            record,
            LifecycleStage.CUSTOMER,
            source=LifecycleHistory.Source.AUTOMATION,
            reason=f"Deal won: {deal_name}"[:255],
            request=request,
        ):
            changed += 1
    return changed


def history_for(entity_type: str, entity_id: Any, *, limit: int = 100) -> list[LifecycleHistory]:
    return list(
        LifecycleHistory.objects.filter(entity_type=entity_type, entity_id=entity_id)
        .select_related("changed_by__user")
        .order_by("-changed_at")[:limit]
    )
