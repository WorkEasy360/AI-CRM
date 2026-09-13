from __future__ import annotations

from django.core.validators import RegexValidator
from django.db import models

from apps.core.models import ArchivableModel, TenantModel

ENTITY_TYPES = ("contact", "company", "deal", "product")
KEY_PATTERN = r"^[a-z][a-z0-9_]{0,39}$"


class CustomFieldDefinition(TenantModel, ArchivableModel):
    """A tenant-defined field on one entity type (ADR-0006). Values live in ``custom_data`` JSONB."""

    class EntityType(models.TextChoices):
        CONTACT = "contact", "Contact"
        COMPANY = "company", "Company"
        DEAL = "deal", "Deal"
        PRODUCT = "product", "Product"

    class FieldType(models.TextChoices):
        TEXT = "text", "Text"
        TEXTAREA = "textarea", "Long text"
        INTEGER = "integer", "Whole number"
        NUMBER = "number", "Decimal number"
        CURRENCY = "currency", "Currency amount"
        PERCENT = "percent", "Percent"
        DATE = "date", "Date"
        DATETIME = "datetime", "Date and time"
        CHECKBOX = "checkbox", "Checkbox"
        DROPDOWN = "dropdown", "Dropdown"
        MULTI_SELECT = "multi_select", "Multi-select"
        EMAIL = "email", "Email"
        PHONE = "phone", "Phone"
        URL = "url", "URL"

    entity_type = models.CharField(max_length=16, choices=EntityType.choices)
    key = models.CharField(max_length=40, validators=[RegexValidator(KEY_PATTERN)])
    label = models.CharField(max_length=80)
    description = models.CharField(max_length=255, blank=True)
    field_type = models.CharField(max_length=16, choices=FieldType.choices)
    options = models.JSONField(default=list, blank=True)
    is_required = models.BooleanField(default=False)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["organization", "entity_type", "key"], name="uniq_customfield_key"),
            models.CheckConstraint(condition=models.Q(key__regex=KEY_PATTERN), name="customfield_key_format"),
        ]
        indexes = [models.Index(fields=["organization", "entity_type", "position"], name="customfield_org_entity_idx")]
        ordering = ["position", "created_at"]

    def __str__(self) -> str:
        return f"{self.entity_type}.{self.key}"
