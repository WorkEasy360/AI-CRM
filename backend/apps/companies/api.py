from __future__ import annotations

from decimal import Decimal

from django.db.models import Count, DecimalField, Exists, IntegerField, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.authz.service import scope
from apps.companies.models import COMPANY_SIZES, Company
from apps.contacts.models import Contact
from apps.core import validators
from apps.core.api.crm import CrmViewSet, crud_permission_map
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import CrmReadSerializer, CustomDataField, owner_field
from apps.crm import records
from apps.crm.records import RecordSpec
from apps.deals.models import Deal
from apps.lifecycle import service as lifecycle
from apps.lifecycle.stages import LIFECYCLE_STAGES, LifecycleStage

SPEC = RecordSpec(module="companies", entity_type="company", model=Company, display=lambda c: c.name)


class CompanySerializer(CrmReadSerializer):
    entity_type = "company"
    contact_count = serializers.IntegerField(read_only=True, default=0)
    open_deal_count = serializers.IntegerField(read_only=True, default=0)
    open_deal_amount = serializers.DecimalField(
        max_digits=18, decimal_places=2, read_only=True, default=Decimal("0.00")
    )
    won_deal_amount = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True, default=Decimal("0.00"))
    next_activity_title = serializers.CharField(read_only=True, default="")

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
            "open_deal_amount",
            "won_deal_amount",
            "last_activity_at",
            "next_activity_at",
            "next_activity_title",
            "lifecycle_stage",
            "lifecycle_changed_at",
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
    lifecycle_stage = serializers.ChoiceField(choices=[(v, v) for v in LIFECYCLE_STAGES], required=False)

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
        "lifecycle": Filter("choice", "lifecycle_stage", choices=LIFECYCLE_STAGES),
        "ids": Filter("uuid_list", "id"),
    },
    sort_fields={
        "name": "name",
        "created_at": "created_at",
        "updated_at": "updated_at",
        "industry": "industry",
        "last_activity_at": "last_activity_at",
        "next_activity_at": "next_activity_at",
        "lifecycle": "lifecycle_stage",
    },
    default_sort="-created_at",
    search_fields=("name", "website", "phone", "industry"),
    custom_field_entity="company",
)


class CompanyViewSet(CrmViewSet):
    spec = SPEC
    filterset = FILTERS
    serializer_class = CompanySerializer
    write_serializer_class = CompanyWriteSerializer
    permission_map = crud_permission_map("companies", stats="companies.view", duplicates="companies.view")

    def perform_create(self, data):
        stage = data.pop("lifecycle_stage", None)
        if stage is not None:
            data["lifecycle_stage"] = lifecycle.clean_stage(stage)
        obj = super().perform_create(data)
        if stage is not None and stage != LifecycleStage.LEAD:
            lifecycle.record_initial_stage(self.request.actor, obj)
        return obj

    def perform_update(self, obj, data, version):
        stage = data.pop("lifecycle_stage", None)
        extra: list[str] = []
        if stage is not None and lifecycle.clean_stage(stage) != obj.lifecycle_stage:
            records.check_update(self.request.actor, self.spec, obj)
            lifecycle.set_stage(self.request.actor, obj, stage, request=self.request._request)
            extra = ["lifecycle_stage", "lifecycle_changed_at"]
        return records.update(
            self.request.actor,
            self.spec,
            obj,
            data,
            expected_version=version,
            request=self.request._request,
            extra_update_fields=extra,
        )

    @action(detail=False, methods=["get"])
    def duplicates(self, request):
        """Companies in scope with the same name (case-insensitive) or the same website host."""
        from apps.contacts.duplicates import find_company_duplicates

        matches = find_company_duplicates(
            request.actor,
            name=request.query_params.get("name", ""),
            website=request.query_params.get("website", ""),
            exclude_id=request.query_params.get("exclude"),
        )
        return Response({"results": matches})

    def base_queryset(self):
        # Two correlated subqueries instead of joining contacts x deals per company and GROUP BY-ing
        # the whole scope: the counts are computed only for the rows a page returns.
        contacts = (
            Contact.objects.filter(company=OuterRef("pk"), archived_at__isnull=True)
            .order_by()
            .values("company")
            .annotate(n=Count("id"))
            .values("n")
        )
        open_deals = (
            Deal.objects.filter(company=OuterRef("pk"), status="open", archived_at__isnull=True)
            .order_by()
            .values("company")
            .annotate(n=Count("id"))
            .values("n")
        )
        from apps.activities.queries import next_activity_title_subquery

        open_amount = (
            Deal.objects.filter(company=OuterRef("pk"), status="open", archived_at__isnull=True)
            .order_by()
            .values("company")
            .annotate(t=Sum("amount_base"))
            .values("t")
        )
        won_amount = (
            Deal.objects.filter(company=OuterRef("pk"), status="won", archived_at__isnull=True)
            .order_by()
            .values("company")
            .annotate(t=Sum("amount_base"))
            .values("t")
        )
        money = DecimalField(max_digits=18, decimal_places=2)
        zero = Value(Decimal("0.00"), output_field=money)
        return (
            Company.objects.select_related("owner__user")
            .defer("search_vector")  # maintained by a trigger, only ever read inside SQL
            .annotate(
                contact_count=Coalesce(Subquery(contacts, output_field=IntegerField()), Value(0)),
                open_deal_count=Coalesce(Subquery(open_deals, output_field=IntegerField()), Value(0)),
                open_deal_amount=Coalesce(Subquery(open_amount, output_field=money), zero),
                won_deal_amount=Coalesce(Subquery(won_amount, output_field=money), zero),
                next_activity_title=next_activity_title_subquery("company"),
            )
        )

    @action(detail=False, methods=["get"])
    def stats(self, request):
        """Footer KPIs computed inside the actor's view scope only."""
        # Scope the plain model queryset (no per-row COUNT annotations) and answer in one query.
        qs = scope(self.request.actor, "companies.view", Company.objects.filter(archived_at__isnull=True))
        deals = Deal.objects.filter(company=OuterRef("pk"))
        agg = qs.annotate(
            has_open=Exists(deals.filter(status="open", archived_at__isnull=True)),
            has_won=Exists(deals.filter(status="won", archived_at__isnull=True)),
            has_deal=Exists(deals),
        ).aggregate(
            total=Count("id"),
            with_open_deals=Count("id", filter=Q(has_open=True)),
            with_won_deals=Count("id", filter=Q(has_won=True)),
            without_deals=Count("id", filter=Q(has_deal=False)),
        )
        return Response(agg)
