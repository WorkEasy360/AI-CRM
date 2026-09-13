from __future__ import annotations

from django.core.validators import EmailValidator
from django.db.models import Count, Q
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.companies.models import Company
from apps.contacts.models import Contact
from apps.core import validators
from apps.core.api.crm import CrmViewSet, crud_permission_map
from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import CrmReadSerializer, CustomDataField, owner_field
from apps.core.records import RecordSpec

SPEC = RecordSpec(module="contacts", entity_type="contact", model=Contact, display=lambda c: c.display_name)


class CompanyRefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)


class ContactSerializer(CrmReadSerializer):
    entity_type = "contact"
    display_name = serializers.CharField(read_only=True)
    company = CompanyRefSerializer(read_only=True)
    open_deal_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Contact
        fields = [
            "id",
            "first_name",
            "last_name",
            "display_name",
            "email",
            "phone",
            "job_title",
            "company",
            "source",
            "address",
            "description",
            "owner",
            "tags",
            "custom_data",
            "open_deal_count",
            "last_activity_at",
            "version",
            "archived_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


def _active_companies():
    return Company.objects.filter(archived_at__isnull=True)


class ContactWriteSerializer(serializers.Serializer):
    first_name = serializers.CharField(max_length=80, required=False, allow_blank=True)
    last_name = serializers.CharField(max_length=80, required=False, allow_blank=True)
    email = serializers.CharField(max_length=254, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=32, required=False, allow_blank=True)
    job_title = serializers.CharField(max_length=120, required=False, allow_blank=True)
    company_id = TenantPrimaryKeyRelatedField(
        source="company", model=Company, queryset_fn=_active_companies, required=False, allow_null=True
    )
    source = serializers.CharField(max_length=60, required=False, allow_blank=True)  # type: ignore[assignment]
    address = serializers.JSONField(required=False)
    description = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    owner_id = owner_field()
    custom_data = CustomDataField("contact")

    def validate_first_name(self, value: str) -> str:
        return validators.clean_text(value, max_length=80)

    def validate_last_name(self, value: str) -> str:
        return validators.clean_text(value, max_length=80)

    def validate_email(self, value: str) -> str:
        value = validators.clean_text(value, max_length=254).lower()
        if value:
            EmailValidator(message="Enter a valid email address.")(value)
        return value

    def validate_phone(self, value: str) -> str:
        return validators.clean_phone(value)

    def validate_job_title(self, value: str) -> str:
        return validators.clean_text(value, max_length=120)

    def validate_source(self, value: str) -> str:
        return validators.clean_text(value, max_length=60)

    def validate_description(self, value: str) -> str:
        return validators.clean_text(value, max_length=5000, allow_newlines=True)

    def validate_address(self, value):
        return validators.clean_address(value)

    def validate(self, attrs):
        merged = {
            "first_name": getattr(self.instance, "first_name", ""),
            "last_name": getattr(self.instance, "last_name", ""),
            "email": getattr(self.instance, "email", ""),
        }
        merged.update({k: v for k, v in attrs.items() if k in merged})
        if not (merged["first_name"] or merged["last_name"] or merged["email"]):
            raise serializers.ValidationError({"first_name": "Provide a first name, last name or email."})
        return attrs


FILTERS = FilterSet(
    filters={
        "owner": Filter("owner", "owner_id"),
        "company": Filter("uuid", "company_id"),
        "has_company": Filter("has", "company_id"),
        "source": Filter("exact", "source", max_length=60),
        "job_title": Filter("text", "job_title", max_length=120),
        "created_from": Filter("date_from", "created_at__date"),
        "created_to": Filter("date_to", "created_at__date"),
        "ids": Filter("uuid_list", "id"),
    },
    sort_fields={
        "name": "last_name",
        "first_name": "first_name",
        "email": "email",
        "created_at": "created_at",
        "updated_at": "updated_at",
        "company": "company__name",
    },
    default_sort="-created_at",
    search_fields=("first_name", "last_name", "email", "phone", "job_title", "company__name"),
    custom_field_entity="contact",
)


class ContactViewSet(CrmViewSet):
    spec = SPEC
    filterset = FILTERS
    serializer_class = ContactSerializer
    write_serializer_class = ContactWriteSerializer
    permission_map = crud_permission_map("contacts", stats="contacts.view")

    def base_queryset(self):
        return Contact.objects.select_related("owner__user", "company").annotate(
            open_deal_count=Count(
                "primary_deals",
                filter=Q(primary_deals__status="open", primary_deals__archived_at__isnull=True),
                distinct=True,
            )
        )

    @action(detail=False, methods=["get"])
    def stats(self, request):
        qs = self.get_queryset().filter(archived_at__isnull=True)
        with_open = qs.filter(primary_deals__status="open", primary_deals__archived_at__isnull=True).distinct().count()
        return Response(
            {
                "total": qs.count(),
                "with_open_deals": with_open,
                "without_deals": qs.filter(primary_deals__isnull=True).count(),
                "untouched": qs.filter(last_activity_at__isnull=True).count(),
            }
        )
