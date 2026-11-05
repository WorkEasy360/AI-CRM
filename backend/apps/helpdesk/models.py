from __future__ import annotations

from django.db import models

from apps.core.models import OwnedModel, TenantModel, VersionedModel

MAX_SUBJECT_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 10_000
MAX_MESSAGE_LENGTH = 10_000

# Hours from creation until a ticket of each priority is overdue (the default SLA; see services.sla_hours).
DEFAULT_SLA_HOURS = {"urgent": 4, "high": 8, "medium": 24, "low": 72}


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

    class Category(models.TextChoices):
        TECHNICAL = "technical", "Technical"
        BILLING = "billing", "Billing"
        ACCOUNT = "account", "Account"
        SUPPORT = "support", "Support"
        SALES = "sales", "Sales"
        OTHER = "other", "Other"

    number = models.PositiveIntegerField()
    subject = models.CharField(max_length=MAX_SUBJECT_LENGTH)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.OPEN)
    priority = models.CharField(max_length=16, choices=Priority.choices, default=Priority.MEDIUM)
    category = models.CharField(max_length=16, choices=Category.choices, default=Category.SUPPORT)
    product = models.ForeignKey("products.Product", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
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


class TicketMessage(TenantModel):
    """One entry in a ticket's thread: a reply to the customer, a message from them, or an internal note.

    Internal notes are for the team only; nothing here is ever shown to the customer except what was sent
    out through a channel (``channel``), which also leaves its own email/WhatsApp message record.
    """

    class Kind(models.TextChoices):
        REPLY = "reply", "Reply"
        CUSTOMER = "customer", "Customer message"
        NOTE = "note", "Internal note"

    class Channel(models.TextChoices):
        NONE = "", "Not sent"
        EMAIL = "email", "Email"
        WHATSAPP = "whatsapp", "WhatsApp"

    ticket = models.ForeignKey(Ticket, on_delete=models.CASCADE, related_name="messages")
    kind = models.CharField(max_length=16, choices=Kind.choices)
    channel = models.CharField(max_length=16, choices=Channel.choices, blank=True, default="")
    author = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    # For customer messages: who wrote it (the requester), since they are not a member.
    author_name = models.CharField(max_length=160, blank=True)
    body = models.TextField()

    class Meta:
        indexes = [models.Index(fields=["organization", "ticket", "created_at"], name="ticketmsg_org_ticket_idx")]
        ordering = ["created_at", "id"]
