"""Helpdesk tickets. Every write is permission-checked against the ticket and audited."""

from __future__ import annotations

from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.accounts.models import Membership
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check, scope
from apps.contacts.models import Contact
from apps.core import validators
from apps.core.concurrency import save_with_version
from apps.crm.records import RecordSpec, resolve_owner
from apps.helpdesk.models import MAX_DESCRIPTION_LENGTH, MAX_SUBJECT_LENGTH, Ticket

SPEC = RecordSpec(module="tickets", entity_type="ticket", model=Ticket, display=lambda t: f"#{t.number} {t.subject}")

_NUMBER_ATTEMPTS = 5


def _clean_subject(value: Any) -> str:
    subject = validators.clean_text(value, max_length=MAX_SUBJECT_LENGTH)
    if not subject:
        raise ValidationError({"subject": "Subject is required."})
    return subject


def _visible_contact(actor: Actor, contact: Contact | None) -> Contact | None:
    """A requester must be a contact the actor may see; anything else reads as unknown (no oracle)."""
    if contact is None:
        return None
    if not scope(actor, "contacts.view", Contact.objects.filter(pk=contact.pk)).exists():
        raise ValidationError({"contact_id": "Unknown contact."})
    return contact


def _apply_rating(ticket: Ticket, rating: int | None) -> None:
    if rating is not None and ticket.status not in (Ticket.Status.RESOLVED, Ticket.Status.CLOSED):
        raise ValidationError({"rating": "A ticket can be rated once it is resolved."})
    ticket.rating = rating


@transaction.atomic
def create_ticket(actor: Actor, data: dict[str, Any], *, request: Any = None) -> Ticket:
    check(actor, "tickets.create")
    owner = resolve_owner(actor, SPEC, data.get("owner"), current=None) or actor.membership
    ticket = Ticket(
        subject=_clean_subject(data.get("subject")),
        description=validators.clean_text(data.get("description"), max_length=MAX_DESCRIPTION_LENGTH, allow_newlines=True),
        status=data.get("status") or Ticket.Status.OPEN,
        priority=data.get("priority") or Ticket.Priority.MEDIUM,
        contact=_visible_contact(actor, data.get("contact")),
        requester_name=validators.clean_text(data.get("requester_name"), max_length=160),
        owner=owner,
    )
    if ticket.status in (Ticket.Status.RESOLVED, Ticket.Status.CLOSED):
        ticket.resolved_at = timezone.now()
    if data.get("rating") is not None:
        _apply_rating(ticket, data["rating"])
    # Per-organization numbering without a lock: take the next number and retry on the (rare)
    # collision with a concurrent create. The savepoint keeps the outer transaction usable.
    for attempt in range(_NUMBER_ATTEMPTS):
        ticket.number = (Ticket.objects.aggregate(n=Max("number"))["n"] or 1000) + 1
        try:
            with transaction.atomic():
                ticket.save()
            break
        except IntegrityError:
            if attempt == _NUMBER_ATTEMPTS - 1:
                raise
            ticket.pk = None
            ticket._state.adding = True
    audit.record(
        "tickets.created",
        request=request,
        user=actor.user,
        resource=ticket,
        metadata={"number": ticket.number, "status": ticket.status, "priority": ticket.priority},
    )
    return ticket


@transaction.atomic
def update_ticket(
    actor: Actor, ticket: Ticket, data: dict[str, Any], *, expected_version: int | None, request: Any = None
) -> Ticket:
    check(actor, "tickets.update", ticket)
    before: dict[str, Any] = {}

    def _set(field: str, value: Any) -> None:
        current = getattr(ticket, field)
        if current != value:
            before[field] = str(current.pk) if hasattr(current, "pk") else current
            setattr(ticket, field, value)

    if "subject" in data:
        _set("subject", _clean_subject(data["subject"]))
    if "description" in data:
        _set(
            "description",
            validators.clean_text(data["description"], max_length=MAX_DESCRIPTION_LENGTH, allow_newlines=True),
        )
    if "priority" in data and data["priority"]:
        _set("priority", data["priority"])
    if "requester_name" in data:
        _set("requester_name", validators.clean_text(data["requester_name"], max_length=160))
    if "contact" in data:
        _set("contact", _visible_contact(actor, data["contact"]))
    if "owner" in data and data["owner"] is not None:
        current_owner: Membership | None = ticket.owner
        _set("owner", resolve_owner(actor, SPEC, data["owner"], current=current_owner))
    if "status" in data and data["status"] and data["status"] != ticket.status:
        _set("status", data["status"])
        done = ticket.status in (Ticket.Status.RESOLVED, Ticket.Status.CLOSED)
        if done and ticket.resolved_at is None:
            ticket.resolved_at = timezone.now()
            before.setdefault("resolved_at", None)
        elif not done:
            if ticket.resolved_at is not None:
                before.setdefault("resolved_at", ticket.resolved_at.isoformat())
            ticket.resolved_at = None
            if ticket.rating is not None:
                before.setdefault("rating", ticket.rating)
            ticket.rating = None  # a reopened ticket's old rating no longer describes it
    if "rating" in data and data["rating"] != ticket.rating:
        before["rating"] = ticket.rating
        _apply_rating(ticket, data["rating"])
    if not before:
        return ticket
    fields = set(before)
    if "status" in before:
        fields |= {"resolved_at", "rating"}
    save_with_version(ticket, expected_version, sorted(fields))
    audit.record(
        "tickets.updated",
        request=request,
        user=actor.user,
        resource=ticket,
        metadata={"number": ticket.number, "changed": sorted(before)},
    )
    return ticket


@transaction.atomic
def delete_ticket(actor: Actor, ticket: Ticket, *, request: Any = None) -> None:
    check(actor, "tickets.delete", ticket)
    audit.record(
        "tickets.deleted", request=request, user=actor.user, resource=ticket, metadata={"number": ticket.number}
    )
    ticket.delete()


def summary(actor: Actor) -> dict[str, Any]:
    """Counts for the helpdesk header, within what the actor may view."""
    tickets = scope(actor, "tickets.view", Ticket.objects.all())
    counts = {row["status"]: row["n"] for row in tickets.values("status").annotate(n=Count("id")).order_by()}
    ratings = tickets.aggregate(rated=Count("id", filter=Q(rating__isnull=False)), satisfied=Count("id", filter=Q(rating__gte=4)))
    return {
        "open": counts.get(Ticket.Status.OPEN, 0),
        "in_progress": counts.get(Ticket.Status.IN_PROGRESS, 0),
        "resolved": counts.get(Ticket.Status.RESOLVED, 0) + counts.get(Ticket.Status.CLOSED, 0),
        "satisfaction": round(100 * ratings["satisfied"] / ratings["rated"]) if ratings["rated"] else None,
        "rated": ratings["rated"],
    }
