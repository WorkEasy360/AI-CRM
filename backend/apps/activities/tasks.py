"""Beat jobs for activities: reminders and overdue notices.

Runs system-wide, then binds each organization in turn so notifications are created inside the right
tenant context (RLS included). Idempotent: a reminder is marked sent in the same transaction.
"""

from __future__ import annotations

import uuid
from collections import defaultdict

import structlog
from celery import shared_task
from django.utils import timezone

from apps.activities.models import Activity, ActivityAttendee
from apps.core.tenancy.context import system_context, tenant_context

log = structlog.get_logger(__name__)

REMINDER_BATCH = 500


@shared_task(name="activities.send_reminders", ignore_result=True, soft_time_limit=120, time_limit=150)
def send_reminders() -> int:
    """Create "task due" / "meeting approaching" / "call scheduled" notifications for due reminders."""
    from apps.notifications import service as notifications

    now = timezone.now()
    with system_context("activities.send_reminders"):
        due = list(
            Activity.all_objects.filter(
                reminder_at__lte=now, reminder_sent_at__isnull=True, status__in=("open", "in_progress")
            )
            .values_list("organization_id", "id")
            .order_by("reminder_at")[:REMINDER_BATCH]
        )
    by_org: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for org_id, activity_id in due:
        by_org[org_id].append(activity_id)
    sent = 0
    for org_id, ids in by_org.items():
        with tenant_context(org_id, reason="task:activities.send_reminders"):
            activities = list(Activity.objects.filter(pk__in=ids).select_related("owner__user", "deal", "contact"))
            attendees: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
            for row in ActivityAttendee.objects.filter(activity_id__in=ids).values_list("activity_id", "membership_id"):
                attendees[row[0]].append(row[1])
            for activity in activities:
                recipients: set[uuid.UUID] = {
                    m for m in (activity.owner_id, *attendees.get(activity.pk, [])) if m is not None
                }
                kind = {"task": "task_due", "meeting": "meeting_soon", "call": "call_soon"}[activity.kind]
                verb = "due" if activity.kind == "task" else "starts"
                when = activity.start_at.strftime("%d %b %H:%M") if activity.start_at else ""
                for membership_id in recipients:
                    notifications.notify(
                        membership_id,
                        kind=kind,
                        title=activity.title,
                        body=f"{activity.get_kind_display()} {verb} {when}".strip(),
                        entity_type="activity",
                        entity_id=activity.pk,
                    )
                    sent += 1
            Activity.objects.filter(pk__in=[a.pk for a in activities]).update(reminder_sent_at=now)
    if sent:
        log.info("activities.reminders_sent", count=sent)
    return sent
