"""Helpdesk tickets. Every write is permission-checked against the ticket and audited."""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Avg, Count, DurationField, ExpressionWrapper, F, Max, Q
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
from apps.helpdesk.models import (
    DEFAULT_SLA_HOURS,
    MAX_DESCRIPTION_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_SUBJECT_LENGTH,
    Ticket,
    TicketMessage,
)

# Tickets are not archivable CrmRecords; the spec is only used for resolve_owner (permissions + field rules).
SPEC = RecordSpec(
    module="tickets",
    entity_type="ticket",
    model=Ticket,  # type: ignore[arg-type]
    display=lambda t: f"#TK-{t.number} {t.subject}",
)

ACTIVE_STATUSES = (Ticket.Status.OPEN, Ticket.Status.IN_PROGRESS)
DONE_STATUSES = (Ticket.Status.RESOLVED, Ticket.Status.CLOSED)
MAX_SLA_HOURS = 24 * 90
SUMMARY_DAYS = 30

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
        description=validators.clean_text(
            data.get("description"), max_length=MAX_DESCRIPTION_LENGTH, allow_newlines=True
        ),
        status=data.get("status") or Ticket.Status.OPEN,
        priority=data.get("priority") or Ticket.Priority.MEDIUM,
        category=data.get("category") or Ticket.Category.SUPPORT,
        product=data.get("product"),
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
    if data.get("priority"):
        _set("priority", data["priority"])
    if data.get("category"):
        _set("category", data["category"])
    if "product" in data:
        _set("product", data["product"])
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


# ----------------------------------------------------------------------------- SLA


def sla_hours(organization: Any) -> dict[str, int]:
    """Hours to resolution per priority: the organization's setting over the defaults."""
    stored = (organization.settings or {}).get("helpdesk_sla_hours") or {}
    out = dict(DEFAULT_SLA_HOURS)
    for priority in DEFAULT_SLA_HOURS:
        value = stored.get(priority)
        if isinstance(value, int) and 1 <= value <= MAX_SLA_HOURS:
            out[priority] = value
    return out


def due_at(ticket: Ticket, hours: dict[str, int]) -> dt.datetime | None:
    if ticket.created_at is None:
        return None
    return ticket.created_at + dt.timedelta(hours=hours.get(ticket.priority, DEFAULT_SLA_HOURS["medium"]))


def overdue_q(hours: dict[str, int], *, now: dt.datetime | None = None) -> Q:
    """Still active and past its SLA. Computed from the current SLA, so a policy change applies at once."""
    now = now or timezone.now()
    past = Q()
    for priority, h in hours.items():
        past |= Q(priority=priority, created_at__lt=now - dt.timedelta(hours=h))
    return Q(status__in=ACTIVE_STATUSES) & past


@transaction.atomic
def update_sla(actor: Actor, values: dict[str, int], *, request: Any = None) -> dict[str, int]:
    from apps.accounts.models import Organization

    check(actor, "org.update")
    clean: dict[str, int] = {}
    for priority, value in values.items():
        if priority not in DEFAULT_SLA_HOURS:
            raise ValidationError({priority: "Unknown priority."})
        if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_SLA_HOURS:
            raise ValidationError({priority: f"Enter whole hours between 1 and {MAX_SLA_HOURS}."})
        clean[priority] = value
    org = Organization.objects.select_for_update().get(pk=actor.organization.pk)
    merged = {**sla_hours(org), **clean}
    org.settings = {**(org.settings or {}), "helpdesk_sla_hours": merged}
    org.save(update_fields=["settings", "updated_at"])
    audit.record("tickets.sla_updated", request=request, user=actor.user, resource=org, metadata={"hours": merged})
    return merged


# ----------------------------------------------------------------------------- thread


def add_message(actor: Actor, ticket: Ticket, data: dict[str, Any], *, request: Any = None) -> TicketMessage:
    """Reply to the customer, log a message from them, or leave an internal note.

    A reply can also go out by email or WhatsApp through the messaging services, so the mailbox, consent,
    24-hour window and plan rules all apply there; if sending is refused, nothing is saved.
    """
    check(actor, "tickets.update", ticket)
    kind = data.get("kind") or TicketMessage.Kind.REPLY
    body = validators.clean_text(data.get("body"), max_length=MAX_MESSAGE_LENGTH, allow_newlines=True)
    if not body:
        raise ValidationError({"body": "Write a message."})
    channel = data.get("send_via") or ""
    if channel and kind != TicketMessage.Kind.REPLY:
        raise ValidationError({"send_via": "Only replies are sent to the customer."})
    with transaction.atomic():
        if channel:
            _send(actor, ticket, channel, body, request=request)
        message = TicketMessage.objects.create(
            ticket=ticket,
            kind=kind,
            channel=channel,
            author=None if kind == TicketMessage.Kind.CUSTOMER else actor.membership,
            author_name=(
                (ticket.contact.display_name if ticket.contact is not None else ticket.requester_name)
                if kind == TicketMessage.Kind.CUSTOMER
                else ""
            ),
            body=body,
        )
        # The first reply picks the ticket up; the ticket's updated time follows the conversation.
        if kind == TicketMessage.Kind.REPLY and ticket.status == Ticket.Status.OPEN:
            update_ticket(actor, ticket, {"status": Ticket.Status.IN_PROGRESS}, expected_version=None, request=request)
        else:
            Ticket.objects.filter(pk=ticket.pk).update(updated_at=timezone.now())
        audit.record(
            "tickets.message_added",
            request=request,
            user=actor.user,
            resource=ticket,
            metadata={"number": ticket.number, "kind": kind, "channel": channel},
        )
    return message


def _send(actor: Actor, ticket: Ticket, channel: str, body: str, *, request: Any) -> None:
    from apps.messaging import services as messaging

    contact = ticket.contact
    if contact is None:
        raise ValidationError({"send_via": "Link the ticket to a contact to send replies."})
    if channel == TicketMessage.Channel.EMAIL:
        if not contact.email:
            raise ValidationError({"send_via": "This contact has no email address."})
        messaging.send_email(
            actor,
            {
                "to": [contact.email],
                "subject": f"Re: [#TK-{ticket.number}] {ticket.subject}"[:255],
                "body": body,
                "contact_id": str(contact.pk),
            },
            request=request,
        )
    elif channel == TicketMessage.Channel.WHATSAPP:
        messaging.send_whatsapp(
            actor, {"contact_id": str(contact.pk), "message_type": "text", "body": body}, request=request
        )
    else:
        raise ValidationError({"send_via": "Choose email or WhatsApp."})


@transaction.atomic
def merge_ticket(actor: Actor, source: Ticket, target: Ticket, *, request: Any = None) -> Ticket:
    """Fold ``source`` into ``target``: its thread moves across and ``source`` is closed with a pointer."""
    if source.pk == target.pk:
        raise ValidationError({"into": "Choose a different ticket."})
    check(actor, "tickets.update", source)
    check(actor, "tickets.update", target)
    moved = TicketMessage.objects.filter(ticket=source).update(ticket=target)
    original = f"Merged from #TK-{source.number}: {source.subject}"
    if source.description:
        original = f"{original}\n\n{source.description}"
    TicketMessage.objects.create(
        ticket=target, kind=TicketMessage.Kind.NOTE, author=actor.membership, body=original[:MAX_MESSAGE_LENGTH]
    )
    TicketMessage.objects.create(
        ticket=source, kind=TicketMessage.Kind.NOTE, author=actor.membership, body=f"Merged into #TK-{target.number}."
    )
    update_ticket(actor, source, {"status": Ticket.Status.CLOSED}, expected_version=None, request=request)
    Ticket.objects.filter(pk=target.pk).update(updated_at=timezone.now())
    audit.record(
        "tickets.merged",
        request=request,
        user=actor.user,
        resource=target,
        metadata={"number": target.number, "merged_number": source.number, "messages": moved},
    )
    return target


_ACTIVITY_LABELS = {
    "tickets.created": "created the ticket",
    "tickets.updated": "updated",
    "tickets.message_added": "added a message",
    "tickets.merged": "merged a ticket into this one",
}


def activity(ticket: Ticket, *, limit: int = 100) -> list[dict[str, Any]]:
    """The ticket's own audit trail, reduced to what any viewer of the ticket may see (no IPs, no ids)."""
    from apps.audit.models import AuditEvent

    events = (
        AuditEvent.objects.filter(resource_type="ticket", resource_id=str(ticket.pk))
        .select_related("actor_user")
        .order_by("-created_at")[:limit]
    )
    out = []
    for event in events:
        meta = event.metadata or {}
        label = _ACTIVITY_LABELS.get(event.action, event.action)
        if event.action == "tickets.updated" and meta.get("changed"):
            label = "changed " + ", ".join(str(f).replace("_", " ") for f in meta["changed"])
        elif event.action == "tickets.message_added":
            label = {"note": "added an internal note", "customer": "logged a customer message"}.get(
                str(meta.get("kind") or ""), "replied" + (f" by {meta['channel']}" if meta.get("channel") else "")
            )
        elif event.action == "tickets.merged" and meta.get("merged_number"):
            label = f"merged #TK-{meta['merged_number']} into this ticket"
        user = event.actor_user
        out.append(
            {
                "id": str(event.pk),
                "action": event.action,
                "label": label,
                "actor": (user.display_name or user.email) if user is not None else "System",
                "created_at": event.created_at.isoformat(),
            }
        )
    return out


# ----------------------------------------------------------------------------- summary


def summary(actor: Actor) -> dict[str, Any]:
    """Counts for the helpdesk header, within what the actor may view, with the previous 30 days to compare."""
    tickets = scope(actor, "tickets.view", Ticket.objects.all())
    hours = sla_hours(actor.organization)
    now = timezone.now()
    since = now - dt.timedelta(days=SUMMARY_DAYS)
    before = since - dt.timedelta(days=SUMMARY_DAYS)
    counts = {row["status"]: row["n"] for row in tickets.values("status").annotate(n=Count("id")).order_by()}
    agg = tickets.aggregate(
        rated=Count("id", filter=Q(rating__isnull=False)),
        satisfied=Count("id", filter=Q(rating__gte=4)),
        overdue=Count("id", filter=overdue_q(hours, now=now)),
        created=Count("id", filter=Q(created_at__gte=since)),
        created_previous=Count("id", filter=Q(created_at__gte=before, created_at__lt=since)),
    )
    duration = ExpressionWrapper(F("resolved_at") - F("created_at"), output_field=DurationField())

    def _avg(start: dt.datetime, end: dt.datetime) -> int | None:
        value = (
            tickets.filter(resolved_at__gte=start, resolved_at__lt=end)
            .annotate(took=duration)
            .aggregate(avg=Avg("took"))["avg"]
        )
        return int(value.total_seconds()) if value is not None else None

    resolved = counts.get(Ticket.Status.RESOLVED, 0) + counts.get(Ticket.Status.CLOSED, 0)
    return {
        "total": sum(counts.values()),
        "open": counts.get(Ticket.Status.OPEN, 0),
        "in_progress": counts.get(Ticket.Status.IN_PROGRESS, 0),
        "resolved": resolved,
        "overdue": agg["overdue"],
        "satisfaction": round(100 * agg["satisfied"] / agg["rated"]) if agg["rated"] else None,
        "rated": agg["rated"],
        "avg_resolution_seconds": _avg(since, now),
        "previous": {
            "days": SUMMARY_DAYS,
            "created": agg["created_previous"],
            "avg_resolution_seconds": _avg(before, since),
        },
        "created": agg["created"],
        "sla_hours": hours,
    }
