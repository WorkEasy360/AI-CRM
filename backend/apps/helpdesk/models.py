from __future__ import annotations

from django.db import models

from apps.core.models import OwnedModel, TenantModel, VersionedModel

MAX_SUBJECT_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 10_000


class Ticket(TenantModel, OwnedModel, VersionedModel):
    """A customer support request. ``owner`` is the assignee, so own/team scopes follow assignment.

    ``number`` is a per-organization sequence for humans ("#1024"); the UUID stays the API identity.
    """

    OWNER_FIELD = "owner"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        IN_PROGRESS = "in_progress", "In Progress"
        RESOLVED = "resolved", "Resolved"
        CLOSED = "closed", "Closed"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        URGENT = "urgent", "Urgent"

    number = models.PositiveIntegerField()
    subject = models.CharField(max_length=MAX_SUBJECT_LENGTH)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.OPEN)
    priority = models.CharField(max_length=16, choices=Priority.choices, default=Priority.MEDIUM)
    # The requester is a CRM contact when known; ``requester_name`` covers walk-ins without a record.
    contact = models.ForeignKey(
        "contacts.Contact", null=True, blank=True, on_delete=models.SET_NULL, related_name="tickets"
    )
    requester_name = models.CharField(max_length=160, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    # Customer satisfaction, 1 (poor) to 5 (great), recorded once the ticket is resolved.
    rating = models.PositiveSmallIntegerField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "number"], name="uniq_ticket_number_per_org"),
            models.CheckConstraint(
                condition=models.Q(rating__isnull=True) | models.Q(rating__gte=1, rating__lte=5),
                name="ticket_rating_range",
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "status", "-updated_at"], name="ticket_org_status_upd_idx"),
            models.Index(fields=["organization", "-number"], name="ticket_org_number_idx"),
        ]
        ordering = ["-number"]
