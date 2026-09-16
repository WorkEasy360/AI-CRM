"""What the knowledge index is allowed to contain, and how each source turns into indexable text.

One registry entry per indexable model. Every entry answers the four questions retrieval needs:

1. *Which CRM record does this text belong to?* -- ``entity_type`` / ``entity_id``, so a chunk can be
   filtered by the caller's scope on that record and cited back with a link they may follow.
2. *Who owns the source row?* -- so the caller's scope on the source's own permission applies too
   (a representative with ``activities.view`` limited to their team never retrieves another team's
   call write-up, exactly as on the record timeline).
3. *Which permission guards this kind of text?* -- ``notes.view``, ``email.view``, ``whatsapp.view``,
   ``activities.view``, ``deals.view``.
4. *What is the text?* -- a list of labelled parts the chunker turns into chunks.

Structured facts (amounts, stages, dates, probabilities) are deliberately **not** indexed here. They
are answered exactly by SQL in ``apps.assistant.crm_tools``; embedding them would only add a way to
get them subtly wrong.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from apps.rag.models import SourceType

# The CRM record a chunk hangs off -> the permission that governs viewing that record.
ENTITY_PERMISSIONS: dict[str, str] = {
    "contact": "contacts.view",
    "company": "companies.view",
    "deal": "deals.view",
    "product": "products.view",
}

# The kind of text -> the permission that governs viewing that kind at all.
SOURCE_PERMISSIONS: dict[str, str] = {
    SourceType.NOTE: "notes.view",
    SourceType.EMAIL: "email.view",
    SourceType.WHATSAPP: "whatsapp.view",
    SourceType.ACTIVITY: "activities.view",
    SourceType.DEAL: "deals.view",
}

# Human labels used in citations and in the deterministic fallback answer.
SOURCE_LABELS: dict[str, str] = {
    SourceType.NOTE: "Note",
    SourceType.EMAIL: "Email",
    SourceType.WHATSAPP: "WhatsApp",
    SourceType.ACTIVITY: "Activity",
    SourceType.DEAL: "Deal",
}

MAX_SOURCE_CHARS = 20_000


@dataclass
class SourceDocument:
    """Everything needed to (re)index one source record. ``parts`` is empty when there is no text."""

    source_type: str
    source_id: uuid.UUID
    entity_type: str = ""
    entity_id: uuid.UUID | None = None
    entity_owner_id: uuid.UUID | None = None
    source_owner_id: uuid.UUID | None = None
    source_version: int = 0
    occurred_at: Any = None
    title: str = ""
    parts: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n\n".join(p for p in self.parts if p.strip())[:MAX_SOURCE_CHARS]

    @property
    def content_hash(self) -> str:
        """Identity of the *content*, not of the row. An unchanged hash skips embedding entirely."""
        payload = f"{self.title}\x1f{self.text}\x1f{self.entity_type}\x1f{self.entity_id}"
        return hashlib.sha256(payload.encode("utf-8", "replace")).hexdigest()


def _entity_of(obj: Any) -> tuple[str, uuid.UUID | None]:
    """The most specific CRM record a message or activity is linked to."""
    for attr, entity_type in (("deal", "deal"), ("contact", "contact"), ("company", "company")):
        value = getattr(obj, f"{attr}_id", None)
        if value:
            return entity_type, value
    return "", None


def _owner_of(entity_type: str, entity_id: uuid.UUID | None) -> uuid.UUID | None:
    """Owner membership of the parent CRM record, read through the tenant-scoped manager."""
    if not entity_type or entity_id is None:
        return None
    model = _entity_model(entity_type)
    if model is None:
        return None
    return model.objects.filter(pk=entity_id).values_list("owner_id", flat=True).first()


def _entity_model(entity_type: str) -> Any:
    from apps.companies.models import Company
    from apps.contacts.models import Contact
    from apps.deals.models import Deal
    from apps.products.models import Product

    return {"contact": Contact, "company": Company, "deal": Deal, "product": Product}.get(entity_type)


# --------------------------------------------------------------------------- extractors


def _note_document(note: Any) -> SourceDocument:
    entity_type = note.entity_type if note.entity_type in ENTITY_PERMISSIONS else ""
    entity_id = note.entity_id if entity_type else None
    return SourceDocument(
        source_type=SourceType.NOTE,
        source_id=note.pk,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_owner_id=_owner_of(entity_type, entity_id),
        source_owner_id=note.author_id,
        occurred_at=note.edited_at or note.created_at,
        title="Note",
        parts=[note.body or ""],
    )


def _email_document(message: Any) -> SourceDocument:
    entity_type, entity_id = _entity_of(message)
    subject = (message.subject or "").strip()
    body = (message.body_text or "").strip()
    return SourceDocument(
        source_type=SourceType.EMAIL,
        source_id=message.pk,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_owner_id=_owner_of(entity_type, entity_id),
        source_owner_id=message.sent_by_id,
        occurred_at=message.sent_at or message.received_at or message.created_at,
        title=subject or f"{message.direction.title()} email",
        parts=[f"Subject: {subject}" if subject else "", body],
    )


def _whatsapp_document(message: Any) -> SourceDocument:
    entity_type, entity_id = _entity_of(message)
    body = (message.body or "").strip()
    return SourceDocument(
        source_type=SourceType.WHATSAPP,
        source_id=message.pk,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_owner_id=_owner_of(entity_type, entity_id),
        source_owner_id=message.sent_by_id,
        occurred_at=message.sent_at or message.received_at or message.created_at,
        title=f"WhatsApp ({message.direction})",
        parts=[body],
    )


def _activity_document(activity: Any) -> SourceDocument:
    """Meetings and calls always (their write-up is the record of the conversation); tasks only when
    somebody wrote something down. A bare 'Call Acme' with no notes carries no knowledge."""
    entity_type, entity_id = _entity_of(activity)
    description = (activity.description or "").strip()
    header = f"{activity.get_kind_display()}: {activity.title}"
    details = []
    if activity.outcome:
        details.append(f"Outcome: {activity.get_outcome_display()}")
    if activity.location:
        details.append(f"Location: {activity.location}")
    indexable = activity.kind in {"meeting", "call"} or bool(description)
    return SourceDocument(
        source_type=SourceType.ACTIVITY,
        source_id=activity.pk,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_owner_id=_owner_of(entity_type, entity_id),
        source_owner_id=activity.owner_id,
        source_version=getattr(activity, "version", 0) or 0,
        occurred_at=activity.completed_at or activity.start_at or activity.created_at,
        title=header,
        parts=[header, " · ".join(details), description] if indexable else [],
    )


def _deal_document(deal: Any) -> SourceDocument:
    description = (deal.description or "").strip()
    return SourceDocument(
        source_type=SourceType.DEAL,
        source_id=deal.pk,
        entity_type="deal",
        entity_id=deal.pk,
        entity_owner_id=deal.owner_id,
        source_owner_id=deal.owner_id,
        source_version=getattr(deal, "version", 0) or 0,
        occurred_at=deal.updated_at,
        title=f"Deal: {deal.name}",
        parts=[description],
    )


@dataclass(frozen=True)
class SourceSpec:
    source_type: str
    model_label: str  # "app_label.ModelName", resolved lazily to avoid import cycles
    extract: Any
    select_related: tuple[str, ...] = ()

    @property
    def model(self) -> Any:
        from django.apps import apps as django_apps

        return django_apps.get_model(self.model_label)

    def queryset(self) -> Any:
        qs = self.model.objects.all()
        return qs.select_related(*self.select_related) if self.select_related else qs


SOURCES: dict[str, SourceSpec] = {
    SourceType.NOTE: SourceSpec(SourceType.NOTE, "notes.Note", _note_document),
    SourceType.EMAIL: SourceSpec(SourceType.EMAIL, "messaging.EmailMessage", _email_document),
    SourceType.WHATSAPP: SourceSpec(SourceType.WHATSAPP, "messaging.WhatsAppMessage", _whatsapp_document),
    SourceType.ACTIVITY: SourceSpec(SourceType.ACTIVITY, "activities.Activity", _activity_document),
    SourceType.DEAL: SourceSpec(SourceType.DEAL, "deals.Deal", _deal_document),
}


def spec_for(source_type: str) -> SourceSpec:
    try:
        return SOURCES[source_type]
    except KeyError as exc:
        raise ValueError(f"Unknown RAG source type: {source_type!r}") from exc


def document_for(source_type: str, obj: Any) -> SourceDocument:
    return spec_for(source_type).extract(obj)


def source_types() -> Iterable[str]:
    return SOURCES.keys()
