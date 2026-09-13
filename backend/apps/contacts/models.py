from __future__ import annotations

from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models

from apps.core.models import CrmRecord


class Contact(CrmRecord):
    first_name = models.CharField(max_length=80, blank=True)
    last_name = models.CharField(max_length=80, blank=True)
    email = models.CharField(max_length=254, blank=True)
    phone = models.CharField(max_length=32, blank=True)
    job_title = models.CharField(max_length=120, blank=True)
    company = models.ForeignKey(
        "companies.Company", null=True, blank=True, on_delete=models.SET_NULL, related_name="contacts"
    )
    source = models.CharField(max_length=60, blank=True)
    address = models.JSONField(default=dict, blank=True)
    description = models.TextField(blank=True)
    last_activity_at = models.DateTimeField(null=True, blank=True)
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta:
        indexes = [
            models.Index(fields=["organization", "last_name", "first_name"], name="contact_org_name_idx"),
            models.Index(fields=["organization", "email"], name="contact_org_email_idx"),
            models.Index(fields=["organization", "company"], name="contact_org_company_idx"),
            models.Index(fields=["organization", "owner"], name="contact_org_owner_idx"),
            models.Index(fields=["organization", "-created_at"], name="contact_org_created_idx"),
            GinIndex(fields=["search_vector"], name="contact_search_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(first_name="") | ~models.Q(last_name="") | ~models.Q(email=""),
                name="contact_has_identity",
            ),
        ]

    def __str__(self) -> str:
        return self.display_name

    @property
    def display_name(self) -> str:
        name = f"{self.first_name} {self.last_name}".strip()
        return name or self.email
