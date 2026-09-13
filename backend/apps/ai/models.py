from __future__ import annotations

from django.db import models

from apps.core.models import TenantModel


class AIUsage(TenantModel):
    """Usage ledger per (member, day, feature, model): requests, tokens and estimated cost."""

    membership = models.ForeignKey("accounts.Membership", on_delete=models.CASCADE, related_name="ai_usage")
    day = models.DateField()
    feature = models.CharField(max_length=32)
    model = models.CharField(max_length=64)
    requests = models.PositiveIntegerField(default=0)
    input_tokens = models.PositiveBigIntegerField(default=0)
    output_tokens = models.PositiveBigIntegerField(default=0)
    cache_read_tokens = models.PositiveBigIntegerField(default=0)
    estimated_cost_usd = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    flagged_inputs = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "membership", "day", "feature", "model"], name="uniq_ai_usage_bucket"
            )
        ]
        indexes = [models.Index(fields=["organization", "day"], name="aiusage_org_day_idx")]
