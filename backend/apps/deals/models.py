from __future__ import annotations

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models

from apps.core.models import CrmRecord, TenantModel


class Deal(CrmRecord):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        WON = "won", "Won"
        LOST = "lost", "Lost"

    name = models.CharField(max_length=160)
    pipeline = models.ForeignKey("pipelines.Pipeline", on_delete=models.PROTECT, related_name="deals")
    stage = models.ForeignKey("pipelines.PipelineStage", on_delete=models.PROTECT, related_name="deals")
    company = models.ForeignKey(
        "companies.Company", null=True, blank=True, on_delete=models.SET_NULL, related_name="deals"
    )
    primary_contact = models.ForeignKey(
        "contacts.Contact", null=True, blank=True, on_delete=models.SET_NULL, related_name="primary_deals"
    )
    amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    currency = models.CharField(max_length=3)
    exchange_rate = models.DecimalField(max_digits=18, decimal_places=8, default=1)
    amount_base = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # True once product lines drive the amount: it is then the sum of the line totals and cannot be set
    # by hand (DECISIONS M2.6). Deals that had lines before Milestone 2 keep their manual amount until
    # one of their lines changes.
    amount_from_lines = models.BooleanField(default=False)
    price_book = models.ForeignKey(
        "products.PriceBook", null=True, blank=True, on_delete=models.SET_NULL, related_name="deals"
    )
    probability = models.PositiveSmallIntegerField(default=10)
    # True when a person set the probability by hand; a stage move resets it to the stage default.
    probability_overridden = models.BooleanField(default=False)
    expected_close_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.OPEN)
    closed_at = models.DateTimeField(null=True, blank=True)
    lost_reason = models.CharField(max_length=255, blank=True)
    stage_entered_at = models.DateTimeField()
    last_activity_at = models.DateTimeField(null=True, blank=True)
    next_activity_at = models.DateTimeField(null=True, blank=True)
    description = models.TextField(blank=True)
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta:
        indexes = [
            models.Index(fields=["organization", "pipeline", "stage"], name="deal_org_pipeline_stage_idx"),
            models.Index(fields=["organization", "status", "expected_close_date"], name="deal_org_status_close_idx"),
            models.Index(fields=["organization", "owner", "status"], name="deal_org_owner_status_idx"),
            models.Index(fields=["organization", "company"], name="deal_org_company_idx"),
            models.Index(fields=["organization", "-created_at"], name="deal_org_created_idx"),
            # Board ordering: newest arrivals per stage.
            models.Index(fields=["organization", "stage", "-stage_entered_at"], name="deal_org_stage_entered_idx"),
            GinIndex(fields=["search_vector"], name="deal_search_idx"),
        ]
        constraints = [
            models.CheckConstraint(condition=models.Q(probability__lte=100), name="deal_probability_range"),
            models.CheckConstraint(condition=models.Q(amount__gte=0), name="deal_amount_nonneg"),
            models.CheckConstraint(condition=models.Q(exchange_rate__gt=0), name="deal_rate_positive"),
            models.CheckConstraint(
                condition=models.Q(status="open", closed_at__isnull=True) | models.Q(closed_at__isnull=False),
                name="deal_closed_at_consistent",
            ),
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def weighted_amount_base(self):
        """Value x probability (the forecast contribution), as the API reports it."""
        from apps.deals.services import weighted_amount

        return weighted_amount(self.amount_base, self.probability)


class DealStageHistory(TenantModel):
    """Append-only (database trigger): one row per stage transition."""

    class Source(models.TextChoices):
        USER = "user", "User"
        IMPORT = "import", "Import"
        AI_CONFIRMED = "ai_confirmed", "AI (confirmed)"
        AUTOMATION = "automation", "Automation"

    deal = models.ForeignKey(Deal, on_delete=models.CASCADE, related_name="stage_history")
    from_stage = models.ForeignKey(
        "pipelines.PipelineStage", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    to_stage = models.ForeignKey("pipelines.PipelineStage", on_delete=models.PROTECT, related_name="+")
    changed_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    changed_at = models.DateTimeField()
    duration_in_previous_stage = models.DurationField(null=True, blank=True)
    source = models.CharField(max_length=16, choices=Source.choices, default=Source.USER)

    class Meta:
        indexes = [models.Index(fields=["deal", "changed_at"], name="dealhistory_deal_changed_idx")]
        ordering = ["changed_at"]


class DealProduct(TenantModel):
    """A product line on a deal. Prices are snapshots so historical deals never drift."""

    deal = models.ForeignKey(Deal, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey("products.Product", on_delete=models.PROTECT, related_name="deal_lines")
    quantity = models.DecimalField(max_digits=12, decimal_places=3, default=1)
    unit_price = models.DecimalField(max_digits=18, decimal_places=2)
    currency = models.CharField(max_length=3)
    discount_percent = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    # quantity x unit price, less the discount. Tax is charged on this.
    subtotal = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    tax_amount = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    # subtotal + tax: what the line contributes to the deal amount.
    line_total = models.DecimalField(max_digits=18, decimal_places=2)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["deal", "product"], name="uniq_deal_product"),
            models.CheckConstraint(condition=models.Q(quantity__gt=0), name="dealproduct_quantity_positive"),
            models.CheckConstraint(
                condition=models.Q(discount_percent__gte=0, discount_percent__lte=100),
                name="dealproduct_discount_range",
            ),
        ]
        ordering = ["created_at"]


class DealContact(TenantModel):
    deal = models.ForeignKey(Deal, on_delete=models.CASCADE, related_name="deal_contacts")
    contact = models.ForeignKey("contacts.Contact", on_delete=models.CASCADE, related_name="deal_links")
    role_label = models.CharField(max_length=60, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["deal", "contact"], name="uniq_deal_contact")]
        ordering = ["created_at"]


class DealConnection(TenantModel):
    """A link between two deals, usually in different pipelines ("connected pipelines").

    Shown on both deals. ``source`` is the deal the link was made from (for an automation, the deal whose
    stage change created ``target``). The pair is unique regardless of direction (enforced in the service).
    """

    class Origin(models.TextChoices):
        MANUAL = "manual", "Manual"
        AUTOMATION = "automation", "Automation"

    source = models.ForeignKey(Deal, on_delete=models.CASCADE, related_name="connections_out")
    target = models.ForeignKey(Deal, on_delete=models.CASCADE, related_name="connections_in")
    origin = models.CharField(max_length=16, choices=Origin.choices, default=Origin.MANUAL)
    created_by = models.ForeignKey(
        "accounts.Membership", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["source", "target"], name="uniq_deal_connection"),
            models.CheckConstraint(condition=~models.Q(source=models.F("target")), name="deal_connection_not_self"),
        ]
        indexes = [
            models.Index(fields=["organization", "source"], name="dealconn_org_source_idx"),
            models.Index(fields=["organization", "target"], name="dealconn_org_target_idx"),
        ]
        ordering = ["created_at"]
