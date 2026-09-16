"""Where CRM writes become indexing intents.

Signals rather than call-site edits: every path that creates customer text -- the API, the WhatsApp
webhook, the mailbox sync, CSV imports, background jobs -- already goes through ``Model.save()``, so
one receiver per model covers them all and no existing service has to learn about the index.

Receivers do the cheapest possible thing inside the CRM transaction: one upsert into the outbox.
Chunking and embedding happen later, in a worker, on the ``rag_indexing`` queue.
"""

from __future__ import annotations

from typing import Any

from django.db.models.signals import post_delete, post_init, post_save

from apps.rag import events
from apps.rag.models import IndexEvent

# CRM records whose chunks carry a denormalised owner for the retrieval pre-filter.
_ENTITY_MODELS = (("contacts.Contact", "contact"), ("companies.Company", "company"), ("deals.Deal", "deal"))
_OWNER_ATTR = "_rag_original_owner_id"


def _indexable(instance: Any) -> bool:
    return getattr(instance, "organization_id", None) is not None and instance.pk is not None


def _make_source_receiver(source_type: str, *, operation: str = IndexEvent.Operation.UPSERT):
    def receiver(sender: Any, instance: Any, **kwargs: Any) -> None:
        if not _indexable(instance):
            return
        events.enqueue(
            organization_id=instance.organization_id,
            source_type=source_type,
            source_id=instance.pk,
            operation=operation,
        )

    return receiver


def _capture_owner(sender: Any, instance: Any, **kwargs: Any) -> None:
    """Remember the owner a record was loaded with, so a reassignment is detectable without a query."""
    setattr(instance, _OWNER_ATTR, getattr(instance, "owner_id", None))


def _make_entity_save_receiver(entity_type: str):
    def receiver(sender: Any, instance: Any, created: bool, **kwargs: Any) -> None:
        if created or not _indexable(instance):
            return
        previous = getattr(instance, _OWNER_ATTR, None)
        current = getattr(instance, "owner_id", None)
        if previous == current:
            return
        events.refresh_entity_owner(
            organization_id=instance.organization_id,
            entity_type=entity_type,
            entity_id=instance.pk,
            owner_id=current,
        )
        setattr(instance, _OWNER_ATTR, current)

    return receiver


def _make_entity_delete_receiver(entity_type: str):
    def receiver(sender: Any, instance: Any, **kwargs: Any) -> None:
        if not _indexable(instance):
            return
        events.purge_entity(organization_id=instance.organization_id, entity_type=entity_type, entity_id=instance.pk)

    return receiver


def connect() -> None:
    """Called once from ``RagConfig.ready()``."""
    from django.apps import apps as django_apps

    from apps.rag.sources import SOURCES

    for source_type, spec in SOURCES.items():
        model = django_apps.get_model(spec.model_label)
        post_save.connect(
            _make_source_receiver(source_type),
            sender=model,
            dispatch_uid=f"rag.index.save.{source_type}",
            weak=False,
        )
        post_delete.connect(
            _make_source_receiver(source_type, operation=IndexEvent.Operation.DELETE),
            sender=model,
            dispatch_uid=f"rag.index.delete.{source_type}",
            weak=False,
        )

    for label, entity_type in _ENTITY_MODELS:
        model = django_apps.get_model(label)
        post_init.connect(_capture_owner, sender=model, dispatch_uid=f"rag.owner.init.{entity_type}", weak=False)
        post_save.connect(
            _make_entity_save_receiver(entity_type),
            sender=model,
            dispatch_uid=f"rag.owner.save.{entity_type}",
            weak=False,
        )
        post_delete.connect(
            _make_entity_delete_receiver(entity_type),
            sender=model,
            dispatch_uid=f"rag.entity.delete.{entity_type}",
            weak=False,
        )
