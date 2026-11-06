from __future__ import annotations

from django.db import models

from apps.billing.editions import ADDONS, EDITIONS, METRICS
from apps.core.models import TenantModel


class Subscription(TenantModel):
    """One per organization: which edition it is on and the state of its billing."""

    class Status(models.TextChoices):
        TRIALING = "trialing", "Trial"
        ACTIVE = "active", "Active"
        PAST_DUE = "past_due", "Past due"
        CANCELLED = "cancelled", "Cancelled"

    class Cycle(models.TextChoices):
        MONTHLY = "monthly", "Monthly"
        ANNUAL = "annual", "Annual"

    edition = models.CharField(max_length=24, choices=[(k, e.name) for k, e in EDITIONS.items()])
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.TRIALING)
    billing_cycle = models.CharField(max_length=8, choices=Cycle.choices, default=Cycle.ANNUAL)
    # Purchased user licences on a paid edition; 0 = not seat-limited (trial, free, grandfathered).
    seats = models.PositiveIntegerField(default=0)
    trial_ends_at = models.DateTimeField(null=True, blank=True)
    current_period_start = models.DateTimeField(null=True, blank=True)
    current_period_end = models.DateTimeField(null=True, blank=True)
    cancel_at_period_end = models.BooleanField(default=False)
    # Organizations that existed before editions were introduced keep every capability they had.
    grandfathered = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["organization"], name="uniq_subscription_per_org")]

    def __str__(self) -> str:
        return f"{self.edition} ({self.status})"


class AddonPurchase(TenantModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        CANCELLED = "cancelled", "Cancelled"

    addon = models.CharField(max_length=32, choices=[(k, a.label) for k, a in ADDONS.items()])
    quantity = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    # One-off packs (AI credits) apply only to the period they were bought in ("2026-10").
    period_key = models.CharField(max_length=10, blank=True)
    purchased_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    cancelled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["organization", "status"], name="addon_org_status_idx")]

    def __str__(self) -> str:
        return f"{self.addon} x{self.quantity}"


class UsageCounter(TenantModel):
    """Atomic usage for metered metrics.

    ``period_key`` is "" for running totals (records), "YYYY-MM" for monthly metrics (AI credits) and
    "YYYY-MM-DD" for daily ones (mass email). Running totals are re-derived from the owning module by
    ``billing.reconcile_usage`` so a missed increment cannot drift forever.
    """

    metric = models.CharField(max_length=32, choices=[(k, m.label) for k, m in METRICS.items()])
    period_key = models.CharField(max_length=10, blank=True)
    used = models.BigIntegerField(default=0)
    reconciled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "metric", "period_key"], name="uniq_usage_counter"),
            models.CheckConstraint(condition=models.Q(used__gte=0), name="usage_counter_non_negative"),
        ]

    def __str__(self) -> str:
        return f"{self.metric}[{self.period_key}]={self.used}"
