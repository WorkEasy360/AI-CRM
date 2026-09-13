from __future__ import annotations

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models

from apps.core.models import CrmRecord

COMPANY_SIZES = ("1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+")


class Company(CrmRecord):
    name = models.CharField(max_length=160)
    website = models.CharField(max_length=2048, blank=True)
    phone = models.CharField(max_length=32, blank=True)
    industry = models.CharField(max_length=80, blank=True)
    company_size = models.CharField(max_length=16, blank=True)
    annual_revenue = models.DecimalField(max_digits=18, decimal_places=2, null=True, blank=True)
    revenue_currency = models.CharField(max_length=3, blank=True)
    address = models.JSONField(default=dict, blank=True)
    source = models.CharField(max_length=60, blank=True)
    description = models.TextField(blank=True)
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta:
        indexes = [
            models.Index(fields=["organization", "name"], name="company_org_name_idx"),
            models.Index(fields=["organization", "owner"], name="company_org_owner_idx"),
            models.Index(fields=["organization", "-created_at"], name="company_org_created_idx"),
            GinIndex(fields=["search_vector"], name="company_search_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(annual_revenue__gte=0) | models.Q(annual_revenue__isnull=True),
                name="company_revenue_nonneg",
            ),
        ]

    def __str__(self) -> str:
        return self.name
