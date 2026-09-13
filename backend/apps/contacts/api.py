from __future__ import annotations

from django.core.validators import EmailValidator
from django.db.models import Count, Exists, F, IntegerField, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.authz.service import scope
from apps.companies.models import Company
from apps.contacts.models import Contact
from apps.core import records, validators
from apps.core.api.crm import CrmViewSet, crud_permission_map
from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import CrmReadSerializer, CustomDataField, owner_field
from apps.core.records import RecordSpec
from apps.deals.models import Deal
from apps.lifecycle import service as lifecycle
from apps.lifecycle.stages import LIFECYCLE_STAGES, LifecycleStage

SPEC = RecordSpec(module="contacts", entity_type="contact", model=Contact, display=lambda c: c.display_name)


class CompanyRefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)


class ContactSerializer(CrmReadSerializer):
    entity_type = "contact"
    display_name = serializers.CharField(read_only=True)
    company = CompanyRefSerializer(read_only=True)
    open_deal_count = serializers.IntegerField(read_only=True, default=0)
    next_activity_title = serializers.CharField(read_only=True, default="")
    lead_score = serializers.SerializerMethodField()

    def get_lead_score(self, obj: Contact) -> int:
        from apps.ai.scoring import score_contact_row

        return score_contact_row(obj)

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
            "next_activity_at",
            "next_activity_title",
            "lifecycle_stage",
            "lifecycle_changed_at",
            "whatsapp_opt_in",
            "whatsapp_opt_in_at",
            "lead_score",
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
    lifecycle_stage = serializers.ChoiceField(choices=[(v, v) for v in LIFECYCLE_STAGES], required=False)
    whatsapp_opt_in = serializers.BooleanField(required=False)

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
        "lifecycle": Filter("choice", "lifecycle_stage", choices=LIFECYCLE_STAGES),
        "ids": Filter("uuid_list", "id"),
    },
    sort_fields={
        "name": "last_name",
        "first_name": "first_name",
        "email": "email",
        "created_at": "created_at",
        "updated_at": "updated_at",
        "last_activity_at": "last_activity_at",
        "next_activity_at": "next_activity_at",
        "lifecycle": "lifecycle_stage",
        "company": "company_name",  # annotation: cursor pagination reads the sort value off the row
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
    permission_map = crud_permission_map("contacts", stats="contacts.view", duplicates="contacts.view")

    def perform_create(self, data):
        stage = data.pop("lifecycle_stage", None)
        opt_in = data.pop("whatsapp_opt_in", None)
        if stage is not None:
            data["lifecycle_stage"] = lifecycle.clean_stage(stage)
        if opt_in:
            data["whatsapp_opt_in"] = True
            data["whatsapp_opt_in_at"] = timezone.now()
        obj = super().perform_create(data)
        if stage is not None and stage != LifecycleStage.LEAD:
            lifecycle.record_initial_stage(self.request.actor, obj)
        return obj

    def perform_update(self, obj, data, version):
        stage = data.pop("lifecycle_stage", None)
        opt_in = data.pop("whatsapp_opt_in", None)
        extra: list[str] = []
        if opt_in is not None and opt_in != obj.whatsapp_opt_in:
            data["whatsapp_opt_in"] = bool(opt_in)
            data["whatsapp_opt_in_at"] = timezone.now() if opt_in else None
        if stage is not None and lifecycle.clean_stage(stage) != obj.lifecycle_stage:
            # Same authorization as any edit; the lifecycle service writes the history row.
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

    def base_queryset(self):
        # Correlated subquery (evaluated per returned row) instead of a LEFT JOIN + GROUP BY over every
        # deal of every contact in scope. ``company_name`` backs the "company" sort: DRF's cursor
        # pagination reads the sort value off the instance, which a plain ``company__name`` ordering
        # cannot provide (it 500s on the second page); Coalesce keeps contacts without a company sortable.
        open_deals = (
            Deal.objects.filter(primary_contact=OuterRef("pk"), status="open", archived_at__isnull=True)
            .order_by()
            .values("primary_contact")
            .annotate(n=Count("id"))
            .values("n")
        )
        from apps.activities.queries import next_activity_title_subquery

        return (
            Contact.objects.select_related("owner__user", "company")
            .defer("search_vector")  # maintained by a trigger, only ever read inside SQL
            .annotate(
                open_deal_count=Coalesce(Subquery(open_deals, output_field=IntegerField()), Value(0)),
                company_name=Coalesce(F("company__name"), Value("")),
                next_activity_title=next_activity_title_subquery("contact"),
            )
        )

    @action(detail=False, methods=["get"])
    def duplicates(self, request):
        """Possible duplicates of a contact being created: same email, same phone digits or same full name.

        Answers only within the actor's view scope (never confirms the existence of a hidden record).
        """
        from apps.contacts.duplicates import find_contact_duplicates

        matches = find_contact_duplicates(
            request.actor,
            email=request.query_params.get("email", ""),
            phone=request.query_params.get("phone", ""),
            first_name=request.query_params.get("first_name", ""),
            last_name=request.query_params.get("last_name", ""),
            exclude_id=request.query_params.get("exclude"),
        )
        return Response({"results": matches})

    @action(detail=False, methods=["get"])
    def stats(self, request):
        # Scope the plain model queryset (no per-row COUNT annotation) and answer in one query.
        qs = scope(self.request.actor, "contacts.view", Contact.objects.filter(archived_at__isnull=True))
        open_deals = Deal.objects.filter(primary_contact=OuterRef("pk"), status="open", archived_at__isnull=True)
        any_deals = Deal.objects.filter(primary_contact=OuterRef("pk"))
        agg = qs.annotate(has_open=Exists(open_deals), has_deal=Exists(any_deals)).aggregate(
            total=Count("id"),
            with_open_deals=Count("id", filter=Q(has_open=True)),
            without_deals=Count("id", filter=Q(has_deal=False)),
            untouched=Count("id", filter=Q(last_activity_at__isnull=True)),
        )
        return Response(agg)
