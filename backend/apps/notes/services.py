from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.core import validators
from apps.notes.models import MAX_NOTE_LENGTH, Note
from apps.notes.registry import resolve_viewable


def _announce(note: Note, change: str) -> None:
    from apps.core.domain_events import RecordChanged, publish

    publish(
        RecordChanged(
            organization_id=note.organization_id,
            entity_type="note",
            entity_ids=(note.pk,),
            change=change,
            owner_id=note.author_id,
            orm_signals_fired=change == "created",
            related=((note.entity_type, str(note.entity_id)),),
        )
    )


def _clean_body(body: str) -> str:
    body = validators.clean_text(body, max_length=MAX_NOTE_LENGTH, allow_newlines=True)
    if not body:
        raise ValidationError({"body": "Note cannot be empty."})
    return body


@transaction.atomic
def create_note(
    actor: Actor, *, entity_type: str, entity_id: Any, body: str, pinned: bool = False, request: Any = None
) -> Note:
    check(actor, "notes.create")
    record = resolve_viewable(actor, entity_type, entity_id)
    note = Note.objects.create(
        entity_type=entity_type,
        entity_id=record.pk,
        body=_clean_body(body),
        author=actor.membership,
        pinned=bool(pinned),
    )
    _announce(note, "created")
    audit.record(
        "notes.created",
        request=request,
        user=actor.user,
        resource=note,
        metadata={"entity_type": entity_type, "entity_id": str(record.pk)},
    )
    return note


@transaction.atomic
def update_note(
    actor: Actor, note: Note, *, body: str | None = None, pinned: bool | None = None, request: Any = None
) -> Note:
    check(actor, "notes.update", note)
    changed: list[str] = []
    if body is not None:
        note.body = _clean_body(body)
        note.edited_at = timezone.now()
        changed += ["body", "edited_at"]
    if pinned is not None and pinned != note.pinned:
        note.pinned = bool(pinned)
        changed.append("pinned")
    if changed:
        note.save(update_fields=[*changed, "updated_at"])
        _announce(note, "updated")
        audit.record("notes.updated", request=request, user=actor.user, resource=note, metadata={"fields": changed})
    return note


@transaction.atomic
def delete_note(actor: Actor, note: Note, *, request: Any = None) -> None:
    check(actor, "notes.delete", note)
    note_id, entity_type, entity_id = note.pk, note.entity_type, note.entity_id
    _announce(note, "deleted")
    note.delete()
    audit.record(
        "notes.deleted",
        request=request,
        user=actor.user,
        resource_type="note",
        resource_id=note_id,
        metadata={"entity_type": entity_type, "entity_id": str(entity_id)},
    )
