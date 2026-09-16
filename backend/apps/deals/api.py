from __future__ import annotations

import datetime as dt
from decimal import Decimal

from django.db.models import Count, IntegerField, OuterRef, Subquery, Sum, Value, prefetch_related_objects
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.authz.service import scope
from apps.companies.models import Company
from apps.contacts.models import Contact
from apps.core import validators
from apps.core.api.crm import CrmViewSet, crud_permission_map
from apps.core.api.fields import TenantPrimaryKeyRelatedField
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import CrmReadSerializer, CustomDataField, MembershipRefSerializer, owner_field
from apps.core.concurrency import expected_version
from apps.deals import services
from apps.deals.models import Deal, DealContact, DealProduct, DealStageHistory
from apps.pipelines.api import StageSerializer
from apps.pipelines.models import Pipeline, PipelineStage
from apps.products.models import Product


class RefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)


class ContactRefSerializer(serializers.Serializer):
    """Primary-contact reference on a deal.

    ``phone`` and ``whatsapp_opt_in`` are read from the contact row already joined for the deal (no
    copy on the deal) and are ``null`` unless the caller's ``contacts.view`` scope covers that contact,
    so a deal never discloses more about a contact than the contact record itself would.
    """

    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(source="display_name", read_only=True)
    email = serializers.CharField(read_only=True)
    phone = serializers.SerializerMethodField()
    whatsapp_opt_in = serializers.SerializerMethodField()

    def _contact_visible(self, obj: Contact) -> bool:
        actor = self.context.get("actor")
        return actor is not None and actor.covers_owner("contacts.view", getattr(obj, "owner_id", None))

    def get_phone(self, obj: Contact) -> str | None:
        return obj.phone if self._contact_visible(obj) else None

    def get_whatsapp_opt_in(self, obj: Contact) -> bool | None:
        return obj.whatsapp_opt_in if self._contact_visible(obj) else None


class StageRefSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)
    kind = serializers.CharField(read_only=True)
    color_token = serializers.CharField(read_only=True)


class DealSerializer(CrmReadSerializer):
    entity_type = "deal"
    pipeline = RefSerializer(read_only=True)
    stage = StageRefSerializer(read_only=True)
    company = RefSerializer(read_only=True)
    primary_contact = ContactRefSerializer(read_only=True)
    line_count = serializers.IntegerField(read_only=True, default=0)
    contact_count = serializers.IntegerField(read_only=True, default=0)
    products_total = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True, default=Decimal("0.00"))
    next_activity_title = serializers.CharField(read_only=True, default="")
    weighted_amount_base = serializers.SerializerMethodField()
    risk_level = serializers.SerializerMethodField()

    def get_weighted_amount_base(self, obj: Deal) -> str:
        """Deal value x probability, computed on the server so no client arithmetic is authoritative."""
        return str(services.weighted_amount(obj.amount_base, obj.probability))

    def get_risk_level(self, obj: Deal) -> str:
        from apps.ai.risk import assess_deal

        return assess_deal(obj, contact_count=getattr(obj, "contact_count", None)).level

    class Meta:
        model = Deal
        fields = [
            "id",
            "name",
            "pipeline",
            "stage",
            "company",
            "primary_contact",
            "amount",
            "currency",
            "exchange_rate",
            "amount_base",
            "probability",
            "probability_overridden",
            "weighted_amount_base",
            "expected_close_date",
            "status",
            "closed_at",
            "lost_reason",
            "stage_entered_at",
            "last_activity_at",
            "next_activity_at",
            "next_activity_title",
            "risk_level",
            "description",
            "owner",
            "tags",
            "custom_data",
            "line_count",
            "contact_count",
            "products_total",
            "version",
            "archived_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class DealCardSerializer(serializers.Serializer):
    """The Kanban card, and only the Kanban card.

    ``DealSerializer`` carries everything the deal detail page needs (35 fields, nested tags, custom
    data, the pipeline reference, the free-text description). A board renders 6 x
    ``BOARD_DEALS_PER_STAGE`` of them, so every field is paid for 300 times: on a 12k-deal tenant the
    full serializer produced a 374 KB payload in 109 ms, of which the card rendered about a third.
    This serializer emits exactly the fields ``kanban-board.tsx`` reads (plus ``version``, which the
    stage-move request sends back as the optimistic-concurrency token).

    Deliberately absent, and each for a reason:
    - ``pipeline`` - a board is one pipeline; the reference was 5% of the payload and repeated 300x.
    - ``description``/``custom_data``/``tags`` - never on a card, and ``description`` is up to 5000
      characters per deal, so it is the field most able to make a board payload explode.
    - the contact's ``email``/``phone``/``whatsapp_opt_in`` - unrendered, and dropping them stops a
      board disclosing contact details the card never shows (two scope checks per card as well).
    """

    id = serializers.UUIDField(read_only=True)
    name = serializers.CharField(read_only=True)
    stage = StageRefSerializer(read_only=True)
    company = RefSerializer(read_only=True)
    primary_contact = serializers.SerializerMethodField()
    owner = MembershipRefSerializer(read_only=True)
    amount = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    currency = serializers.CharField(read_only=True)
    amount_base = serializers.DecimalField(max_digits=18, decimal_places=2, read_only=True)
    weighted_amount_base = serializers.SerializerMethodField()
    probability = serializers.IntegerField(read_only=True)
    probability_overridden = serializers.BooleanField(read_only=True)
    expected_close_date = serializers.DateField(read_only=True)
    status = serializers.CharField(read_only=True)
    next_activity_title = serializers.CharField(read_only=True, default="")
    risk_level = serializers.SerializerMethodField()
    version = serializers.IntegerField(read_only=True)

    def get_primary_contact(self, obj: Deal) -> dict[str, str] | None:
        """Name only: the card shows a name, so the board ships a name."""
        contact = obj.primary_contact
        return None if contact is None else {"id": str(contact.pk), "name": contact.display_name}

    def get_weighted_amount_base(self, obj: Deal) -> str:
        return str(services.weighted_amount(obj.amount_base, obj.probability))

    def get_risk_level(self, obj: Deal) -> str:
        from apps.ai.risk import assess_deal

        return assess_deal(obj, contact_count=getattr(obj, "contact_count", None)).level


def _active_pipelines():
    return Pipeline.objects.filter(archived_at__isnull=True)


def _active_stages():
    return PipelineStage.objects.filter(archived_at__isnull=True)


def _active_companies():
    return Company.objects.filter(archived_at__isnull=True)


def _active_contacts():
    return Contact.objects.filter(archived_at__isnull=True)


def _active_products():
    return Product.objects.filter(archived_at__isnull=True, status=Product.Status.ACTIVE)


class DealWriteSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=160)
    pipeline_id = TenantPrimaryKeyRelatedField(
        source="pipeline", model=Pipeline, queryset_fn=_active_pipelines, required=False
    )
    stage_id = TenantPrimaryKeyRelatedField(
        source="stage", model=PipelineStage, queryset_fn=_active_stages, required=False
    )
    company_id = TenantPrimaryKeyRelatedField(
        source="company", model=Company, queryset_fn=_active_companies, required=False, allow_null=True
    )
    primary_contact_id = TenantPrimaryKeyRelatedField(
        source="primary_contact", model=Contact, queryset_fn=_active_contacts, required=False, allow_null=True
    )
    amount = serializers.DecimalField(max_digits=18, decimal_places=2, required=False)
    currency = serializers.CharField(max_length=3, required=False)
    exchange_rate = serializers.DecimalField(max_digits=18, decimal_places=8, required=False, allow_null=True)
    probability = serializers.IntegerField(min_value=0, max_value=100, required=False)
    expected_close_date = serializers.DateField(required=False, allow_null=True)
    lost_reason = serializers.CharField(max_length=255, required=False, allow_blank=True)
    description = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    owner_id = owner_field()
    custom_data = CustomDataField("deal")

    def validate_name(self, value: str) -> str:
        value = validators.clean_text(value, max_length=160)
        if not value:
            raise serializers.ValidationError("Name is required.")
        return value

    def validate_amount(self, value: Decimal) -> Decimal:
        return validators.clean_amount(value) or Decimal("0.00")

    def validate_currency(self, value: str) -> str:
        return validators.clean_currency(value, default="")

    def validate_exchange_rate(self, value: Decimal | None) -> Decimal | None:
        if value is None:
            return None
        if not value.is_finite() or value <= 0 or value > Decimal("1000000"):
            raise serializers.ValidationError("Exchange rate must be a positive number.")
        return value

    def validate_expected_close_date(self, value: dt.date | None) -> dt.date | None:
        if value is not None and not (dt.date(2000, 1, 1) <= value <= dt.date(2100, 12, 31)):
            raise serializers.ValidationError("Date out of range.")
        return value

    def validate_lost_reason(self, value: str) -> str:
        return validators.clean_text(value, max_length=255)

    def validate_description(self, value: str) -> str:
        return validators.clean_text(value, max_length=5000, allow_newlines=True)


class StageMoveSerializer(serializers.Serializer):
    stage_id = serializers.UUIDField()
    version = serializers.IntegerField(min_value=1, required=False)
    lost_reason = serializers.CharField(max_length=255, required=False, allow_blank=True)


class DealProductSerializer(serializers.ModelSerializer):
    product = RefSerializer(read_only=True)
    sku = serializers.CharField(source="product.sku", read_only=True)

    class Meta:
        model = DealProduct
        fields = [
            "id",
            "product",
            "sku",
            "quantity",
            "unit_price",
            "currency",
            "discount_percent",
            "tax_rate",
            "line_total",
            "created_at",
        ]
        read_only_fields = fields


class DealProductInputSerializer(serializers.Serializer):
    product_id = TenantPrimaryKeyRelatedField(
        source="product", model=Product, queryset_fn=_active_products, required=False
    )
    quantity = serializers.DecimalField(max_digits=12, decimal_places=3, required=False, min_value=Decimal("0.001"))
    unit_price = serializers.DecimalField(max_digits=18, decimal_places=2, required=False, min_value=Decimal(0))
    discount_percent = serializers.DecimalField(
        max_digits=5, decimal_places=2, required=False, min_value=Decimal(0), max_value=Decimal(100)
    )
    tax_rate = serializers.DecimalField(
        max_digits=5, decimal_places=2, required=False, min_value=Decimal(0), max_value=Decimal(100)
    )


class DealContactSerializer(serializers.ModelSerializer):
    contact = ContactRefSerializer(read_only=True)

    class Meta:
        model = DealContact
        fields = ["id", "contact", "role_label", "created_at"]
        read_only_fields = fields


class DealContactInputSerializer(serializers.Serializer):
    contact_id = TenantPrimaryKeyRelatedField(source="contact", model=Contact, queryset_fn=_active_contacts)
    role_label = serializers.CharField(max_length=60, required=False, allow_blank=True, default="")


class StageHistorySerializer(serializers.ModelSerializer):
    from_stage = StageRefSerializer(read_only=True)
    to_stage = StageRefSerializer(read_only=True)
    changed_by = MembershipRefSerializer(read_only=True)
    duration_seconds = serializers.SerializerMethodField()

    class Meta:
        model = DealStageHistory
        fields = ["id", "from_stage", "to_stage", "changed_by", "changed_at", "duration_seconds", "source"]
        read_only_fields = fields

    def get_duration_seconds(self, obj: DealStageHistory) -> int | None:
        return int(obj.duration_in_previous_stage.total_seconds()) if obj.duration_in_previous_stage else None


FILTERS = FilterSet(
    filters={
        "owner": Filter("owner", "owner_id"),
        "pipeline": Filter("uuid", "pipeline_id"),
        "stage": Filter("uuid", "stage_id"),
        "company": Filter("uuid", "company_id"),
        "contact": Filter("uuid", "primary_contact_id"),
        "status": Filter("choice", "status", choices=tuple(Deal.Status.values)),
        "close_from": Filter("date_from", "expected_close_date"),
        "close_to": Filter("date_to", "expected_close_date"),
        "amount_min": Filter("decimal_min", "amount_base"),
        "amount_max": Filter("decimal_max", "amount_base"),
        "probability_min": Filter("decimal_min", "probability"),
        "ids": Filter("uuid_list", "id"),
    },
    sort_fields={
        "name": "name",
        "amount": "amount_base",
        "probability": "probability",
        "expected_close_date": "expected_close_date",
        "created_at": "created_at",
        "updated_at": "updated_at",
        "stage_entered_at": "stage_entered_at",
        "last_activity_at": "last_activity_at",
        "next_activity_at": "next_activity_at",
    },
    default_sort="-created_at",
    search_fields=("name", "company__name", "primary_contact__first_name", "primary_contact__last_name"),
    custom_field_entity="deal",
)

# Cards rendered per column; the column footer links to the list view for the rest. 100 cards x 6 stages
# cost ~200 ms of serialization per board load on a 12k-deal tenant; 50 keeps the board interactive.
BOARD_DEALS_PER_STAGE = 50


class DealViewSet(CrmViewSet):
    spec = services.SPEC
    filterset = FILTERS
    serializer_class = DealSerializer
    write_serializer_class = DealWriteSerializer
    permission_map = crud_permission_map(
        "deals",
        board="deals.view",
        history="deals.view",
        move_stage="deals.change_stage",
        products="deals.view",
        add_product="deals.update",
        update_product="deals.update",
        remove_product="deals.update",
        contacts="deals.view",
        add_contact="deals.update",
        remove_contact="deals.update",
        insights="deals.view",
    )

    def base_queryset(self):
        # Correlated subqueries instead of LEFT JOIN + GROUP BY: Postgres evaluates them only for the
        # rows a page actually returns, rather than aggregating every line of every deal in scope.
        from apps.activities.queries import next_activity_title_subquery

        lines = DealProduct.objects.filter(deal=OuterRef("pk")).order_by().values("deal")
        # Only the deal's own columns are restricted. The select_related rows (company, contact,
        # membership, user) come back whole on purpose: TenantModel.__init__ reads ``organization_id``,
        # so a deferred column on a joined tenant row makes instantiating that row refresh_from_db
        # itself, and that recurses until the stack ends. Those rows are one per card and small; the
        # 300x cost of a board is the deal rows, and those this does trim.
        contacts = DealContact.objects.filter(deal=OuterRef("pk")).order_by().values("deal")
        # ``pipeline`` and ``stage`` are prefetched (one small query each per page) instead of
        # select_related: an INNER JOIN to those tiny RLS-filtered tables invites the planner to drive
        # the whole query from them, and with the tenant predicate applied twice (ORM filter + policy)
        # it underestimates the deal fan-out by orders of magnitude and scans every deal of the tenant
        # before the top-N sort (12k deals: ~200 ms). Starting from ``deals_deal`` with LEFT joins only,
        # the ordered ``(organization, created_at)`` index serves a page in ~1 ms. RLS is unchanged.
        return (
            Deal.objects.select_related("owner__user", "company", "primary_contact")
            .prefetch_related("pipeline", "stage")
            .defer("search_vector")  # maintained by a trigger, only ever read inside SQL
            .annotate(
                line_count=Coalesce(
                    Subquery(lines.annotate(n=Count("id")).values("n"), output_field=IntegerField()), Value(0)
                ),
                contact_count=Coalesce(
                    Subquery(contacts.annotate(n=Count("id")).values("n"), output_field=IntegerField()), Value(0)
                ),
                products_total=Subquery(lines.annotate(t=Sum("line_total")).values("t")),
                next_activity_title=next_activity_title_subquery("deal"),
            )
        )

    @action(detail=True, methods=["get"])
    def insights(self, request, pk=None):
        """Rules-based risk, score and next best action for one deal (no LLM, no extra permissions)."""
        from apps.ai.insights import deal_insights

        deal = self.get_object()
        return Response(deal_insights(request.actor, deal))

    def perform_create(self, data):
        return services.create_deal(self.request.actor, data, request=self.request._request)

    def perform_update(self, obj, data, version):
        return services.update_deal(
            self.request.actor, obj, data, expected_version=version, request=self.request._request
        )

    @action(detail=True, methods=["post"], url_path="stage")
    def move_stage(self, request, pk=None):
        deal = self.get_object()  # view-scoped lookup + change_stage object check (404/403 semantics)
        ser = StageMoveSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        version = expected_version(request._request, request.data)
        services.move_stage(
            request.actor,
            deal.pk,
            stage_id=ser.validated_data["stage_id"],
            expected_version=version,
            lost_reason=ser.validated_data.get("lost_reason"),
            request=request._request,
        )
        return Response(self.read(deal))

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        deal = self.get_object()
        qs = (
            DealStageHistory.objects.filter(deal=deal)
            .select_related("from_stage", "to_stage", "changed_by__user")
            .order_by("-changed_at")[:500]
        )
        return Response({"results": StageHistorySerializer(qs, many=True).data})

    def board_queryset(self):
        """Cards only: the columns ``DealCardSerializer`` emits, plus the ones risk scoring reads.

        The list queryset annotates four correlated subqueries and loads every deal column; a board
        needs neither. ``contact_count`` stays because ``assess_deal`` uses it for the risk dot, and
        the deferred-but-loaded columns (``last_activity_at``, ``stage_entered_at``, ``created_at``,
        ``next_activity_at``) are what that same assessment reads. ``pipeline`` is not joined or
        prefetched at all - the board is already one pipeline.
        """
        from apps.activities.queries import next_activity_title_subquery

        contacts = DealContact.objects.filter(deal=OuterRef("pk")).order_by().values("deal")
        return (
            Deal.objects.select_related("owner__user", "company", "primary_contact")
            .prefetch_related("stage")  # see base_queryset: a join here wrecks the planner's estimate
            .only(
                "id",
                "organization",
                "version",
                "name",
                "amount",
                "currency",
                "amount_base",
                "probability",
                "probability_overridden",
                "expected_close_date",
                "status",
                "stage_id",
                "company_id",
                "primary_contact_id",
                "owner_id",
                # read by assess_deal, not serialized
                "last_activity_at",
                "next_activity_at",
                "stage_entered_at",
                "created_at",
            )
            .annotate(
                contact_count=Coalesce(
                    Subquery(contacts.annotate(n=Count("id")).values("n"), output_field=IntegerField()), Value(0)
                ),
                next_activity_title=next_activity_title_subquery("deal"),
            )
        )

    @action(detail=False, methods=["get"])
    def board(self, request):
        """Kanban payload: stages of one pipeline with the actor's visible deals and per-stage totals."""
        pipeline_id = request.query_params.get("pipeline")
        pipeline = (
            get_object_or_404(Pipeline.objects.filter(archived_at__isnull=True), pk=pipeline_id)
            if pipeline_id
            else Pipeline.objects.filter(archived_at__isnull=True).order_by("-is_default", "position").first()
        )
        if pipeline is None:
            return Response({"pipeline": None, "stages": []})
        # Totals and ranking use a plain queryset; the per-row annotations are only needed for the
        # rows actually rendered (see ``annotated`` below).
        base = scope(request.actor, "deals.view", Deal.objects.filter(pipeline=pipeline, archived_at__isnull=True))
        params = {k: v for k, v in request.query_params.items() if k not in {"pipeline"}}
        base, _ = self.filterset.apply(base, params, actor=request.actor)
        totals = {
            row["stage_id"]: row
            for row in base.values("stage_id").annotate(total=Sum("amount_base"), count=Count("id")).order_by()
        }
        stages = list(pipeline.stages.filter(archived_at__isnull=True).order_by("position"))
        # One small LIMIT query per stage (index deal_org_stage_entered_idx, annotations evaluated for
        # the returned rows only) instead of ranking every deal of the pipeline and shipping hundreds
        # of ids back to the database. Stages are few; deals are not.
        annotated, _ = self.filterset.apply(
            scope(
                request.actor, "deals.view", self.board_queryset().filter(pipeline=pipeline, archived_at__isnull=True)
            ),
            params,
            actor=request.actor,
        )
        by_stage: dict = {
            s.pk: list(
                annotated.prefetch_related(None)
                .filter(stage_id=s.pk)
                .order_by("-stage_entered_at", "-id")[:BOARD_DEALS_PER_STAGE]
            )
            for s in stages
        }
        all_deals = [d for bucket in by_stage.values() for d in bucket]
        # One prefetch for the whole board rather than one per stage bucket.
        prefetch_related_objects(all_deals, "stage")
        # Cards carry no tags and no custom data, so the board needs neither the tag window query that
        # ranked the rendered ids nor the custom-field definitions - two queries and a window scan gone.
        ctx = dict(self.get_serializer_context())
        payload = []
        for stage in stages:
            agg = totals.get(stage.pk, {})
            payload.append(
                {
                    **StageSerializer(stage).data,
                    "deal_count": agg.get("count", 0),
                    "total_amount_base": str(agg.get("total") or Decimal("0.00")),
                    "deals": DealCardSerializer(by_stage[stage.pk], many=True, context=ctx).data,
                    "has_more": agg.get("count", 0) > len(by_stage[stage.pk]),
                }
            )
        return Response({"pipeline": {"id": str(pipeline.pk), "name": pipeline.name}, "stages": payload})

    # ------------------------------------------------------------------ product lines
    @action(detail=True, methods=["get"])
    def products(self, request, pk=None):
        deal = self.get_object()
        lines = DealProduct.objects.filter(deal=deal).select_related("product")
        return Response({"results": DealProductSerializer(lines, many=True).data})

    @action(detail=True, methods=["post"], url_path="products/add")
    def add_product(self, request, pk=None):
        deal = self.get_object()
        ser = DealProductInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if "product" not in data:
            raise serializers.ValidationError({"product_id": "product_id is required."})
        line = services.add_product(
            request.actor,
            deal,
            product=data["product"],
            quantity=data.get("quantity", Decimal(1)),
            unit_price=data.get("unit_price"),
            discount_percent=data.get("discount_percent", Decimal(0)),
            tax_rate=data.get("tax_rate"),
            request=request._request,
        )
        line = DealProduct.objects.select_related("product").get(pk=line.pk)
        return Response(DealProductSerializer(line).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch"], url_path=r"products/(?P<line_id>[0-9a-f-]{36})")
    def update_product(self, request, pk=None, line_id=None):
        deal = self.get_object()
        line = get_object_or_404(DealProduct.objects.filter(deal=deal), pk=line_id)
        ser = DealProductInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = {k: v for k, v in ser.validated_data.items() if k != "product"}
        services.update_product_line(request.actor, deal, line, request=request._request, **data)
        line = DealProduct.objects.select_related("product").get(pk=line.pk)
        return Response(DealProductSerializer(line).data)

    @action(detail=True, methods=["post"], url_path=r"products/(?P<line_id>[0-9a-f-]{36})/remove")
    def remove_product(self, request, pk=None, line_id=None):
        deal = self.get_object()
        line = get_object_or_404(DealProduct.objects.filter(deal=deal), pk=line_id)
        services.remove_product(request.actor, deal, line, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------ contacts
    @action(detail=True, methods=["get"])
    def contacts(self, request, pk=None):
        deal = self.get_object()
        links = DealContact.objects.filter(deal=deal).select_related("contact")
        return Response({"results": DealContactSerializer(links, many=True).data})

    @action(detail=True, methods=["post"], url_path="contacts/add")
    def add_contact(self, request, pk=None):
        deal = self.get_object()
        ser = DealContactInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        link = services.add_contact(
            request.actor,
            deal,
            contact=ser.validated_data["contact"],
            role_label=ser.validated_data["role_label"],
            request=request._request,
        )
        link = DealContact.objects.select_related("contact").get(pk=link.pk)
        return Response(DealContactSerializer(link).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="contacts/remove")
    def remove_contact(self, request, pk=None):
        deal = self.get_object()
        contact_id = request.data.get("contact_id") if isinstance(request.data, dict) else None
        ser = serializers.UUIDField()
        try:
            parsed = ser.to_internal_value(contact_id)
        except serializers.ValidationError as exc:
            raise serializers.ValidationError({"contact_id": "Expected a UUID."}) from exc
        services.remove_contact(request.actor, deal, contact_id=parsed, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)
