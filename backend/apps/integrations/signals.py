"""Where CRM writes become integration events.

Two publishers feed the same outbox:

- ``post_save`` receivers, for every write that goes through ``Model.save()`` -- the API, imports, the
  assistant, inbound sync, background jobs.
- ``apps.core.domain_events``, for the writes that do not: bulk archive/restore/reassign, a deal stage
  move and a lifecycle promotion are single ``QuerySet.update()`` statements, and Django emits no
  signal for those. They used to change the database without telling any external system.

The receivers only ever write an outbox row, and only for organizations that actually use
integrations. Nothing here calls out over the network.
"""

from __future__ import annotations

from typing import Any

from django.db.models.signals import post_init, post_save

from apps.core import domain_events
from apps.integrations import events

_ENTITY_MODELS = (("contacts.Contact", "contact"), ("companies.Company", "company"), ("deals.Deal", "deal"))
# Saves that only touch bookkeeping columns are not business changes worth announcing.
_NOISE_FIELDS = frozenset({"last_activity_at", "next_activity_at", "updated_at", "search_vector"})
_STAGE_ATTR = "_integrations_original_stage_id"
_STATUS_ATTR = "_integrations_original_status"


def _is_noise(update_fields: Any) -> bool:
    return bool(update_fields) and set(update_fields) <= _NOISE_FIELDS


def _make_record_receiver(entity_type: str):
    def receiver(sender: Any, instance: Any, created: bool, update_fields: Any = None, **kwargs: Any) -> None:
        if instance.organization_id is None or _is_noise(update_fields):
            return
        events.emit(
            organization_id=instance.organization_id,
            event_type=f"{entity_type}.{'created' if created else 'updated'}",
            entity_type=entity_type,
            entity_id=instance.pk,
        )
        if entity_type == "deal":
            previous = getattr(instance, _STAGE_ATTR, None)
            if not created and previous is not None and previous != instance.stage_id:
                events.emit(
                    organization_id=instance.organization_id,
                    event_type="deal.stage_changed",
                    entity_type="deal",
                    entity_id=instance.pk,
                )
            setattr(instance, _STAGE_ATTR, instance.stage_id)

    return receiver


def _capture_stage(sender: Any, instance: Any, **kwargs: Any) -> None:
    setattr(instance, _STAGE_ATTR, instance.__dict__.get("stage_id"))


def _capture_status(sender: Any, instance: Any, **kwargs: Any) -> None:
    setattr(instance, _STATUS_ATTR, instance.__dict__.get("status"))


def _activity_saved(sender: Any, instance: Any, created: bool, **kwargs: Any) -> None:
    previous = getattr(instance, _STATUS_ATTR, None)
    setattr(instance, _STATUS_ATTR, instance.status)
    if instance.organization_id is None or instance.kind != "task" or instance.status != "completed":
        return
    if not created and previous == "completed":
        return
    events.emit(
        organization_id=instance.organization_id,
        event_type="task.completed",
        entity_type="activity",
        entity_id=instance.pk,
    )


# How a domain change maps onto the webhook vocabulary. A stage move is announced twice on purpose:
# subscribers to "deal.updated" should see it too, exactly as they would for an inline edit.
_CHANGE_EVENTS: dict[str, tuple[str, ...]] = {
    "created": ("{entity}.created",),
    "updated": ("{entity}.updated",),
    "archived": ("{entity}.updated",),
    "restored": ("{entity}.updated",),
    "reassigned": ("{entity}.updated",),
    "lifecycle_changed": ("{entity}.updated",),
    "tagged": ("{entity}.updated",),
    "untagged": ("{entity}.updated",),
    "stage_changed": ("deal.updated", "deal.stage_changed"),
    "completed": ("task.completed",),
}


def _on_record_changed(event: domain_events.RecordChanged) -> None:
    """Domain-event subscriber: write outbox rows for changes ``post_save`` never saw."""
    if event.orm_signals_fired:
        return  # the post_save receiver above already emitted for this write
    for template in _CHANGE_EVENTS.get(event.change, ()):
        event_type = template.format(entity=event.entity_type)
        for entity_id in event.entity_ids:
            events.emit(
                organization_id=event.organization_id,
                event_type=event_type,
                entity_type=event.entity_type,
                entity_id=entity_id,
            )


def connect() -> None:
    """Called once from ``IntegrationsConfig.ready()``."""
    # critical: the outbox row must commit with the change it describes, so a failure here has to
    # roll the CRM write back rather than quietly drop the event.
    domain_events.subscribe(_on_record_changed, critical=True)

    from django.apps import apps as django_apps

    for label, entity_type in _ENTITY_MODELS:
        model = django_apps.get_model(label)
        post_save.connect(
            _make_record_receiver(entity_type),
            sender=model,
            dispatch_uid=f"integrations.save.{entity_type}",
            weak=False,
        )
    deal = django_apps.get_model("deals.Deal")
    post_init.connect(_capture_stage, sender=deal, dispatch_uid="integrations.deal.stage", weak=False)
    activity = django_apps.get_model("activities.Activity")
    post_init.connect(_capture_status, sender=activity, dispatch_uid="integrations.activity.status", weak=False)
    post_save.connect(_activity_saved, sender=activity, dispatch_uid="integrations.activity.save", weak=False)
