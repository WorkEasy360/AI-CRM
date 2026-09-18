"""Where CRM writes become integration events.

Signals rather than call-site edits, like ``apps.rag.signals``: the API, imports, the assistant, inbound
sync and background jobs all save through ``Model.save()``. The receivers only write an outbox row
(and only for organizations that use integrations). Bulk ``QuerySet.update()`` calls do not emit
events; the scheduled sync reconciles those records.
"""

from __future__ import annotations

from typing import Any

from django.db.models.signals import post_init, post_save

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


def connect() -> None:
    """Called once from ``IntegrationsConfig.ready()``."""
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
