from __future__ import annotations

from decimal import Decimal

from django.db.models import Count, Q
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.companies.models import COMPANY_SIZES, Company
from apps.core import validators
from apps.core.api.crm import CrmViewSet, crud_permission_map
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import CrmReadSerializer, CustomDataField, owner_field
from apps.core.records import RecordSpec

SPEC = RecordSpec(module="companies", entity_type="company", model=Company, display=lambda c: c.name)


class CompanySerializer(CrmReadSerializer):
    entity_type = "company"
    contact_count = serializers.IntegerField(read_only=True, default=0)
    open_deal_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Company
        fields = [
            "id",
            "name",
            "website",
            "phone",
            "industry",
            "company_size",
            "annual_revenue",
            "revenue_currency",
            "address",
            "source",
            "description",
            "owner",
            "tags",
            "custom_data",
            "contact_count",
            "open_deal_count",
            "version",
            "archived_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class CompanyWriteSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=160)
    website = serializers.CharField(max_length=2048, required=False, allow_blank=True)
    phone = serializers.CharField(max_length=32, required=False, allow_blank=True)
    industry = serializers.CharField(max_length=80, required=False, allow_blank=True)
    company_size = serializers.ChoiceField(choices=[(s, s) for s in COMPANY_SIZES], required=False, allow_blank=True)
    annual_revenue = serializers.DecimalField(max_digits=18, decimal_places=2, required=False, allow_null=True)
    revenue_currency = serializers.CharField(max_length=3, required=False, allow_blank=True)
    address = serializers.JSONField(required=False)
    source = serializers.CharField(max_length=60, required=False, allow_blank=True)  # type: ignore[assignment]
    description = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    owner_id = owner_field()
    custom_data = CustomDataField("company")

    def validate_name(self, value: str) -> str:
        value = validators.clean_text(value, max_length=160)
        if not value:
            raise serializers.ValidationError("Name is required.")
        return value

    def validate_website(self, value: str) -> str:
        return validators.clean_url(value)

    def validate_phone(self, value: str) -> str:
        return validators.clean_phone(value)

    def validate_industry(self, value: str) -> str:
        return validators.clean_text(value, max_length=80)

    def validate_source(self, value: str) -> str:
        return validators.clean_text(value, max_length=60)

    def validate_description(self, value: str) -> str:
        return validators.clean_text(value, max_length=5000, allow_newlines=True)

    def validate_annual_revenue(self, value: Decimal | None) -> Decimal | None:
        return validators.clean_amount(value)

    def validate_revenue_currency(self, value: str) -> str:
        return validators.clean_currency(value, default="") if value else ""

    def validate_address(self, value):
        return validators.clean_address(value)


FILTERS = FilterSet(
    filters={
        "owner": Filter("owner", "owner_id"),
        "industry": Filter("text", "industry", max_length=80),
        "company_size": Filter("choice", "company_size", choices=COMPANY_SIZES),
        "source": Filter("exact", "source", max_length=60),
        "created_from": Filter("date_from", "created_at__date"),
        "created_to": Filter("date_to", "created_at__date"),
        "ids": Filter("uuid_list", "id"),
    },
    sort_fields={"name": "name", "created_at": "created_at", "updated_at": "updated_at", "industry": "industry"},
    default_sort="-created_at",
    search_fields=("name", "website", "phone", "industry"),
    custom_field_entity="company",
)


class CompanyViewSet(CrmViewSet):
    spec = SPEC
    filterset = FILTERS
    serializer_class = CompanySerializer
    write_serializer_class = CompanyWriteSerializer
    permission_map = crud_permission_map("companies", stats="companies.view")

    def base_queryset(self):
        return Company.objects.select_related("owner__user").annotate(
            contact_count=Count("contacts", filter=Q(contacts__archived_at__isnull=True), distinct=True),
            open_deal_count=Count(
                "deals", filter=Q(deals__status="open", deals__archived_at__isnull=True), distinct=True
            ),
        )

    @action(detail=False, methods=["get"])
    def stats(self, request):
        """Footer KPIs computed inside the actor's view scope only."""
        qs = self.get_queryset().filter(archived_at__isnull=True)
        return Response(
            {
                "total": qs.count(),
                "with_open_deals": qs.filter(deals__status="open", deals__archived_at__isnull=True).distinct().count(),
                "with_won_deals": qs.filter(deals__status="won", deals__archived_at__isnull=True).distinct().count(),
                "without_deals": qs.filter(deals__isnull=True).count(),
            }
        )
