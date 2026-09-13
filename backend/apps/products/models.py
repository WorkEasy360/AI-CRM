from __future__ import annotations

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models

from apps.core.models import CrmRecord


class Product(CrmRecord):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        INACTIVE = "inactive", "Inactive"

    name = models.CharField(max_length=160)
    sku = models.CharField(max_length=64, blank=True)
    description = models.TextField(blank=True)
    unit_price = models.DecimalField(max_digits=18, decimal_places=2, default=0)
    currency = models.CharField(max_length=3)
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    tax_label = models.CharField(max_length=40, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "sku"], condition=~models.Q(sku=""), name="uniq_product_sku_per_org"
            ),
            models.CheckConstraint(condition=models.Q(unit_price__gte=0), name="product_price_nonneg"),
            models.CheckConstraint(condition=models.Q(tax_rate__gte=0, tax_rate__lte=100), name="product_tax_range"),
        ]
        indexes = [
            models.Index(fields=["organization", "status", "name"], name="product_org_status_name_idx"),
            models.Index(fields=["organization", "-created_at"], name="product_org_created_idx"),
            GinIndex(fields=["search_vector"], name="product_search_idx"),
        ]

    def __str__(self) -> str:
        return self.name
