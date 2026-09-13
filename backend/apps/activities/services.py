"""Activity lifecycle: create / update / complete / cancel / delete, plus the record stamps.

Every write re-checks ``activities.*`` against the activity owner (own/team/all scopes), validates the
linked records within the actor's *view* scope, keeps ``last_activity_at`` / ``next_activity_at`` on the
linked deal, contact and company in sync, and writes an audit event.
"""

from __future__ import annotations

import datetime as dt
import uuid
import zoneinfo
from typing import Any

from django.db import transaction
from django.db.models import Max, Min, Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.accounts.models import Membership
from apps.activities.models import Activity, ActivityAttendee
from apps.activities.queries import OPEN_STATUSES
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.catalogue import SCOPE_ALL
from apps.authz.service import check
from apps.core import validators
from apps.core.concurrency import save_with_version
from apps.core.exceptions import DomainError
from apps.dashboards import cache as dashboard_cache

MAX_ATTENDEES = 50
MAX_DURATION_MINUTES = 24 * 60
MAX_REMINDER_MINUTES = 30 * 24 * 60
DEFAULT_CALL_MINUTES = 15
DEFAULT_MEETING_MINUTES = 30

EDITABLE_FIELDS = (
    "title",
    "description",
    "priority",
    "start_at",
    "end_at",
    "all_day",
    "duration_minutes",
    "timezone",
    "location",
    "meeting_url",
    "direction",
    "outcome",
    "reminder_minutes",
    "contact",
    "company",
    "deal",
)


# ----------------------------------------------------------------------------- validation


def _clean_title(value: Any) -> str:
    title = validators.clean_text(value, max_length=160)
    if not title:
        raise ValidationError({"title": "Title is required."})
    return title


def _clean_timezone(value: Any) -> str:
    name = (value or "").strip()
    if not name:
        return ""
    if name not in zoneinfo.available_timezones():
        raise ValidationError({"timezone": "Unknown timezone."})
    return name


def _check_date(value: dt.datetime | None, field: str) -> None:
    if value is not None and not (
        dt.datetime(2000, 1, 1, tzinfo=dt.UTC) <= value <= dt.datetime(2100, 12, 31, tzinfo=dt.UTC)
    ):
        raise ValidationError({field: "Date out of range."})


def _normalise(kind: str, data: dict[str, Any], *, current: Activity | None = None) -> dict[str, Any]:
    """Apply kind rules to a merged (existing + incoming) field set. Returns the cleaned changes."""
    merged: dict[str, Any] = {}
    if current is not None:
        for f in EDITABLE_FIELDS:
            merged[f] = getattr(current, f)
    merged.update(data)
    out: dict[str, Any] = dict(data)
    if "title" in data:
        out["title"] = _clean_title(data["title"])
    if "description" in data:
        out["description"] = validators.clean_text(data.get("description"), max_length=5000, allow_newlines=True)
    if "location" in data:
        out["location"] = validators.clean_text(data.get("location"), max_length=255)
    if "meeting_url" in data:
        out["meeting_url"] = validators.clean_url(data.get("meeting_url"))
    if "timezone" in data:
        out["timezone"] = _clean_timezone(data.get("timezone"))
    start = merged.get("start_at")
    end = merged.get("end_at")
    _check_date(start, "start_at")
    _check_date(end, "end_at")
    duration = merged.get("duration_minutes")
    if duration is not None and not (0 < int(duration) <= MAX_DURATION_MINUTES):
        raise ValidationError({"duration_minutes": f"Enter 1 to {MAX_DURATION_MINUTES} minutes."})
    reminder = merged.get("reminder_minutes")
    if reminder is not None and not (0 <= int(reminder) <= MAX_REMINDER_MINUTES):
        raise ValidationError({"reminder_minutes": "Reminder is out of range."})

    if kind == Activity.Kind.TASK:
        for f in ("direction", "outcome", "location", "meeting_url"):
            if merged.get(f):
                raise ValidationError({f: "Not applicable to a task."})
        out.setdefault("end_at", None)
        out.setdefault("duration_minutes", None)
    elif kind == Activity.Kind.CALL:
        if start is None:
            raise ValidationError({"start_at": "A call needs a date and time."})
        if merged.get("direction") not in Activity.Direction.values:
            raise ValidationError({"direction": "Choose inbound or outbound."})
        if merged.get("outcome") and merged["outcome"] not in Activity.Outcome.values:
            raise ValidationError({"outcome": "Unknown outcome."})
        minutes = int(duration) if duration else DEFAULT_CALL_MINUTES
        out["duration_minutes"] = minutes
        out["end_at"] = start + dt.timedelta(minutes=minutes)
        out["all_day"] = False
    elif kind == Activity.Kind.MEETING:
        if start is None:
            raise ValidationError({"start_at": "A meeting needs a start."})
        if merged.get("all_day"):
            day_start = start.replace(hour=0, minute=0, second=0, microsecond=0)
            out["start_at"] = day_start
            out["end_at"] = day_start + dt.timedelta(days=1) - dt.timedelta(seconds=1)
        else:
            if end is None:
                end = start + dt.timedelta(minutes=DEFAULT_MEETING_MINUTES)
            if end < start:
                raise ValidationError({"end_at": "The meeting must end after it starts."})
            out["end_at"] = end
            out["duration_minutes"] = max(1, int((end - start).total_seconds() // 60))
        for f in ("direction", "outcome"):
            if merged.get(f):
                raise ValidationError({f: "Not applicable to a meeting."})
    else:
        raise ValidationError({"kind": "Unknown activity kind."})
    reminder_source = out.get("start_at", start)
    if reminder is not None and reminder_source is not None:
        out["reminder_at"] = reminder_source - dt.timedelta(minutes=int(reminder))
    elif "reminder_minutes" in data or "start_at" in data:
        out["reminder_at"] = None if reminder is None else out.get("reminder_at")
    return out


def _resolve_owner(actor: Actor, owner: Membership | None, *, current: Membership | None) -> Membership:
    if owner is None:
        return current or actor.membership
    if current is not None and owner.pk == current.pk:
        return current
    if owner.pk == actor.membership.pk:
        return owner
    if actor.scope_for("activities.update") != SCOPE_ALL:
        raise PermissionDenied(detail="You cannot assign activities to other members.", code="reassign_denied")
    if owner.status != Membership.Status.ACTIVE:
        raise ValidationError({"owner_id": "Owner must be an active member."})
    return owner


def _check_links(actor: Actor, data: dict[str, Any]) -> None:
    """Linked records must be within the actor's view scope (404 semantics are the serializer's job;
    here a hidden record simply cannot be linked)."""
    from apps.authz.service import scope

    for field, module in (("contact", "contacts"), ("company", "companies"), ("deal", "deals")):
        obj = data.get(field)
        if obj is None:
            continue
        model = type(obj)
        if not scope(actor, f"{module}.view", model.objects.filter(pk=obj.pk)).exists():
            raise ValidationError({f"{field}_id": "Record not found."})
    contact, company, deal = data.get("contact"), data.get("company"), data.get("deal")
    # Convenience: fill the company from the contact/deal when not given.
    if company is None and contact is not None and contact.company_id:
        data["company"] = contact.company
    if data.get("company") is None and deal is not None and deal.company_id:
        data["company"] = deal.company
    if contact is None and deal is not None and deal.primary_contact_id:
        data["contact"] = deal.primary_contact


# ----------------------------------------------------------------------------- stamps


def sync_stamps(*, deal_id: Any = None, contact_id: Any = None, company_id: Any = None) -> None:
    """Recompute ``last_activity_at`` / ``next_activity_at`` on the linked records (cheap aggregates)."""
    now = timezone.now()
    targets: list[tuple[str, Any, Any]] = []
    if deal_id:
        from apps.deals.models import Deal

        targets.append(("deal", Deal, deal_id))
    if contact_id:
        from apps.contacts.models import Contact

        targets.append(("contact", Contact, contact_id))
    if company_id:
        from apps.companies.models import Company

        targets.append(("company", Company, company_id))
    for relation, model, pk in targets:
        agg = Activity.objects.filter(**{f"{relation}_id": pk}).aggregate(
            last=Max("completed_at", filter=Q(status=Activity.Status.COMPLETED)),
            next=Min("start_at", filter=Q(status__in=OPEN_STATUSES, start_at__gte=now)),
        )
        model.objects.filter(pk=pk).update(last_activity_at=agg["last"], next_activity_at=agg["next"])


def _touch(activity: Activity, previous: Activity | None = None) -> None:
    ids = {
        "deal_id": {activity.deal_id, getattr(previous, "deal_id", None)},
        "contact_id": {activity.contact_id, getattr(previous, "contact_id", None)},
        "company_id": {activity.company_id, getattr(previous, "company_id", None)},
    }
    for key, values in ids.items():
        for value in values:
            if value:
                sync_stamps(**{key: value})


# ----------------------------------------------------------------------------- lifecycle


@transaction.atomic
def create_activity(actor: Actor, data: dict[str, Any], *, request: Any = None) -> Activity:
    check(actor, "activities.create")
    dashboard_cache.invalidate(actor.organization.pk)
    kind = data.pop("kind", None)
    if kind not in Activity.Kind.values:
        raise ValidationError({"kind": "Choose task, call or meeting."})
    attendee_ids: list[uuid.UUID] = data.pop("attendee_ids", None) or []
    owner = _resolve_owner(actor, data.pop("owner", None), current=None)
    completed = bool(data.pop("completed", False))
    status = data.pop("status", None)
    _check_links(actor, data)
    fields = _normalise(kind, data)
    if kind == Activity.Kind.TASK and fields.get("start_at") is None:
        fields["start_at"] = None
    activity = Activity(kind=kind, owner=owner, created_by=actor.membership, updated_by=actor.membership, **fields)
    if status in {Activity.Status.IN_PROGRESS}:
        activity.status = status
    if completed or status == Activity.Status.COMPLETED:
        activity.status = Activity.Status.COMPLETED
        activity.completed_at = timezone.now()
        activity.reminder_at = None
    activity.save()
    _set_attendees(actor, activity, attendee_ids)
    _touch(activity)
    audit.record(
        "activities.created",
        request=request,
        user=actor.user,
        resource=activity,
        resource_type="activity",
        metadata={
            "kind": kind,
            "title": activity.title,
            "deal_id": str(activity.deal_id) if activity.deal_id else None,
            "contact_id": str(activity.contact_id) if activity.contact_id else None,
            "status": activity.status,
        },
    )
    return activity


@transaction.atomic
def update_activity(
    actor: Actor, activity: Activity, data: dict[str, Any], *, expected_version: int | None, request: Any = None
) -> Activity:
    check(actor, "activities.update", activity)
    dashboard_cache.invalidate(actor.organization.pk)
    previous = Activity(deal_id=activity.deal_id, contact_id=activity.contact_id, company_id=activity.company_id)
    attendee_ids = data.pop("attendee_ids", None)
    status = data.pop("status", None)
    data.pop("kind", None)
    changed: list[str] = []
    if "owner" in data:
        new_owner = _resolve_owner(actor, data.pop("owner"), current=activity.owner)
        if activity.owner_id != new_owner.pk:
            activity.owner = new_owner
            changed.append("owner")
    _check_links(actor, data)
    fields = _normalise(activity.kind, data, current=activity)
    for name, value in fields.items():
        if getattr(activity, name) != value:
            setattr(activity, name, value)
            changed.append(name)
    if status is not None and status != activity.status:
        _apply_status(activity, status)
        changed.extend(["status", "completed_at", "reminder_at"])
    if attendee_ids is not None:
        _set_attendees(actor, activity, attendee_ids)
    if not changed:
        if expected_version is not None and expected_version != activity.version:
            from apps.core.exceptions import ConflictError

            raise ConflictError(
                "The activity was modified by someone else. Reload and try again.", code="version_conflict"
            )
        return activity
    activity.updated_by = actor.membership
    save_with_version(activity, expected_version, [*dict.fromkeys(changed), "updated_by"])
    _touch(activity, previous)
    audit.record(
        "activities.completed"
        if "status" in changed and activity.status == Activity.Status.COMPLETED
        else "activities.updated",
        request=request,
        user=actor.user,
        resource=activity,
        resource_type="activity",
        metadata={"fields": sorted(set(changed)), "status": activity.status, "outcome": activity.outcome},
    )
    return activity


def _apply_status(activity: Activity, status: str) -> None:
    if status not in Activity.Status.values:
        raise ValidationError({"status": "Unknown status."})
    activity.status = status
    if status == Activity.Status.COMPLETED:
        activity.completed_at = activity.completed_at or timezone.now()
        activity.reminder_at = None
    else:
        activity.completed_at = None
        if status == Activity.Status.CANCELLED:
            activity.reminder_at = None
        elif activity.reminder_minutes is not None and activity.start_at is not None:
            activity.reminder_at = activity.start_at - dt.timedelta(minutes=activity.reminder_minutes)


@transaction.atomic
def complete_activity(
    actor: Actor,
    activity: Activity,
    *,
    expected_version: int | None,
    outcome: str | None = None,
    note: str | None = None,
    request: Any = None,
) -> Activity:
    data: dict[str, Any] = {"status": Activity.Status.COMPLETED}
    if outcome is not None and activity.kind == Activity.Kind.CALL:
        data["outcome"] = outcome
    if note:
        note = validators.clean_text(note, max_length=5000, allow_newlines=True)
        data["description"] = f"{activity.description}\n\n{note}".strip() if activity.description else note
    return update_activity(actor, activity, data, expected_version=expected_version, request=request)


@transaction.atomic
def delete_activity(actor: Actor, activity: Activity, *, request: Any = None) -> None:
    check(actor, "activities.delete", activity)
    dashboard_cache.invalidate(actor.organization.pk)
    snapshot = Activity(deal_id=activity.deal_id, contact_id=activity.contact_id, company_id=activity.company_id)
    activity_id, title, kind = activity.pk, activity.title, activity.kind
    activity.delete()
    _touch(snapshot)
    audit.record(
        "activities.deleted",
        request=request,
        user=actor.user,
        resource_type="activity",
        resource_id=activity_id,
        metadata={"title": title, "kind": kind},
    )


def _set_attendees(actor: Actor, activity: Activity, membership_ids: list[uuid.UUID]) -> None:
    ids = list(dict.fromkeys(membership_ids))
    if len(ids) > MAX_ATTENDEES:
        raise ValidationError({"attendee_ids": f"At most {MAX_ATTENDEES} attendees."})
    if not ids and activity.pk and not ActivityAttendee.objects.filter(activity=activity).exists():
        return
    members = {m.pk: m for m in Membership.objects.active().filter(pk__in=ids)}
    missing = [str(i) for i in ids if i not in members]
    if missing:
        raise ValidationError({"attendee_ids": "Unknown member."})
    current = set(ActivityAttendee.objects.filter(activity=activity).values_list("membership_id", flat=True))
    wanted = set(ids)
    ActivityAttendee.objects.filter(activity=activity, membership_id__in=current - wanted).delete()
    ActivityAttendee.objects.bulk_create(
        [
            ActivityAttendee(activity=activity, membership=members[m], organization_id=activity.organization_id)
            for m in wanted - current
        ]
    )


# ----------------------------------------------------------------------------- reminders (beat)


def due_reminders(now: dt.datetime | None = None, *, limit: int = 500) -> list[Activity]:
    now = now or timezone.now()
    return list(
        Activity.objects.filter(reminder_at__lte=now, reminder_sent_at__isnull=True, status__in=OPEN_STATUSES)
        .select_related("owner__user", "deal", "contact")
        .order_by("reminder_at")[:limit]
    )


def mark_reminder_sent(activity_ids: list[uuid.UUID], *, when: dt.datetime | None = None) -> int:
    return Activity.objects.filter(pk__in=activity_ids, reminder_sent_at__isnull=True).update(
        reminder_sent_at=when or timezone.now()
    )


def require_open(activity: Activity) -> None:
    if not activity.is_open:
        raise DomainError("This activity is already closed.", code="activity_closed", status_code=409)
