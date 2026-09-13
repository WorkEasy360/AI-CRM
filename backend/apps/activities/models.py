"""Tasks, calls and meetings: one table, one lifecycle, three kinds.

A single ``Activity`` model keeps the calendar, the record timelines, reminders, "next activity" stamps
and the dashboard counters consistent. Kind-specific fields are nullable and validated per kind in the
service, so a task never carries a call outcome and a meeting always has an end.
"""

from __future__ import annotations

from typing import ClassVar

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models

from apps.core.models import OwnedModel, TenantModel, VersionedModel


class Activity(TenantModel, OwnedModel, VersionedModel):
    OWNER_FIELD: ClassVar[str | None] = "owner"

    class Kind(models.TextChoices):
        TASK = "task", "Task"
        CALL = "call", "Call"
        MEETING = "meeting", "Meeting"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        IN_PROGRESS = "in_progress", "In progress"
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        NORMAL = "normal", "Normal"
        HIGH = "high", "High"
        URGENT = "urgent", "Urgent"

    class Direction(models.TextChoices):
        INBOUND = "inbound", "Inbound"
        OUTBOUND = "outbound", "Outbound"

    class Outcome(models.TextChoices):
        CONNECTED = "connected", "Connected"
        NO_ANSWER = "no_answer", "No answer"
        VOICEMAIL = "voicemail", "Voicemail"
        BUSY = "busy", "Busy"
        INTERESTED = "interested", "Interested"
        NOT_INTERESTED = "not_interested", "Not interested"
        FOLLOW_UP_REQUIRED = "follow_up_required", "Follow-up required"

    kind = models.CharField(max_length=8, choices=Kind.choices)
    title = models.CharField(max_length=160)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.OPEN)
    priority = models.CharField(max_length=8, choices=Priority.choices, default=Priority.NORMAL)
    # Tasks: due date/time. Calls and meetings: start. ``all_day`` tasks/meetings ignore the time part.
    start_at = models.DateTimeField(null=True, blank=True)
    end_at = models.DateTimeField(null=True, blank=True)
    all_day = models.BooleanField(default=False)
    duration_minutes = models.PositiveIntegerField(null=True, blank=True)
    timezone = models.CharField(max_length=64, blank=True)
    location = models.CharField(max_length=255, blank=True)
    meeting_url = models.CharField(max_length=2048, blank=True)
    direction = models.CharField(max_length=8, choices=Direction.choices, blank=True)
    outcome = models.CharField(max_length=24, choices=Outcome.choices, blank=True)
    reminder_minutes = models.PositiveIntegerField(null=True, blank=True)
    reminder_at = models.DateTimeField(null=True, blank=True)
    reminder_sent_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    contact = models.ForeignKey(
        "contacts.Contact", null=True, blank=True, on_delete=models.SET_NULL, related_name="activities"
    )
    company = models.ForeignKey(
        "companies.Company", null=True, blank=True, on_delete=models.SET_NULL, related_name="activities"
    )
    deal = models.ForeignKey("deals.Deal", null=True, blank=True, on_delete=models.SET_NULL, related_name="activities")
    created_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+", editable=False
    )
    updated_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+", editable=False
    )
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta:
        indexes = [
            models.Index(fields=["organization", "owner", "status", "start_at"], name="activity_org_owner_idx"),
            models.Index(fields=["organization", "kind", "start_at"], name="activity_org_kind_start_idx"),
            models.Index(fields=["organization", "start_at"], name="activity_org_start_idx"),
            models.Index(fields=["organization", "deal"], name="activity_org_deal_idx"),
            models.Index(fields=["organization", "contact"], name="activity_org_contact_idx"),
            models.Index(fields=["organization", "company"], name="activity_org_company_idx"),
            models.Index(fields=["organization", "reminder_at"], name="activity_org_reminder_idx"),
            models.Index(fields=["organization", "-created_at"], name="activity_org_created_idx"),
            GinIndex(fields=["search_vector"], name="activity_search_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(end_at__isnull=True)
                | models.Q(start_at__isnull=True)
                | models.Q(end_at__gte=models.F("start_at")),
                name="activity_end_after_start",
            ),
            models.CheckConstraint(
                condition=models.Q(status="completed", completed_at__isnull=False) | ~models.Q(status="completed"),
                name="activity_completed_at_consistent",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.kind}: {self.title}"

    @property
    def is_open(self) -> bool:
        return self.status in {self.Status.OPEN, self.Status.IN_PROGRESS}


class ActivityAttendee(TenantModel):
    """A member invited to a meeting (or call). Attendees see the activity on their own calendar."""

    activity = models.ForeignKey(Activity, on_delete=models.CASCADE, related_name="attendees")
    membership = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["activity", "membership"], name="uniq_activity_attendee")]
        indexes = [models.Index(fields=["organization", "membership"], name="attendee_org_member_idx")]
