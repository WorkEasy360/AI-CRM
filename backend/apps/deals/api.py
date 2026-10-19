from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from django.db.models import (
    Count,
    DecimalField,
    ExpressionWrapper,
    F,
    IntegerField,
    OuterRef,
    Q,
    Subquery,
    Sum,
    Value,
    prefetch_related_objects,
)
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
from apps.deals.models import Deal, DealConnection, DealContact, DealProduct, DealStageHistory
from apps.pipelines.api import StageSerializer
from apps.pipelines.models import Pipeline, PipelineStage
from apps.products.models import PriceBook, Product


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
    price_book = RefSerializer(read_only=True, allow_null=True)
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
            "amount_from_lines",
            "price_book",
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

    def to_representation(self, instance: Deal) -> dict:
        from apps.authz import fields as field_rules
        from apps.crm import schema

        data = field_rules.mask(self.context.get("actor"), "deal", super().to_representation(instance))
        # The pipeline's card layout: extra fields, already narrowed to those the actor may see.
        card_fields = self.context.get("card_fields") or []
        if card_fields:
            data["extra"] = [
                {"key": f.key, "label": f.label, "value": schema.read_value(instance, f)} for f in card_fields
            ]
        return data

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


def _active_price_books():
    return PriceBook.objects.filter(archived_at__isnull=True, is_active=True)


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
    price_book_id = TenantPrimaryKeyRelatedField(
        source="price_book", model=PriceBook, queryset_fn=_active_price_books, required=False, allow_null=True
    )
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


LINE_MONEY_FIELDS = ("unit_price", "subtotal", "tax_amount", "line_total")


class DealProductSerializer(serializers.ModelSerializer):
    """One product line. Obeys the "deal_line" field rules, and a hidden deal amount hides line money too."""

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
            "subtotal",
            "tax_amount",
            "line_total",
            "created_at",
        ]
        read_only_fields = fields

    def to_representation(self, instance: DealProduct) -> dict:
        from apps.authz import fields as field_rules

        actor = self.context.get("actor")
        data = field_rules.mask(actor, "deal_line", super().to_representation(instance))
        if "amount" in field_rules.hidden_fields(actor, "deal"):
            for f in LINE_MONEY_FIELDS:
                data.pop(f, None)
        return data


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
    version = serializers.IntegerField(min_value=1, required=False)


class ConnectionSerializer(serializers.Serializer):
    id = serializers.UUIDField(read_only=True)
    direction = serializers.CharField(read_only=True)
    origin = serializers.CharField(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)
    deal = serializers.SerializerMethodField()

    def get_deal(self, obj: dict) -> dict:
        deal = obj["deal"]
        data = {
            "id": str(deal.pk),
            "name": deal.name,
            "pipeline": {"id": str(deal.pipeline_id), "name": deal.pipeline.name},
            "stage": {"id": str(deal.stage_id), "name": deal.stage.name, "kind": deal.stage.kind},
            "status": deal.status,
            "amount": str(deal.amount),
            "currency": deal.currency,
            "owner": {"id": str(deal.owner_id), "display_name": deal.owner.user.display_name} if deal.owner else None,
        }
        from apps.authz import fields as field_rules

        return field_rules.mask(self.context.get("actor"), "deal", data)


class ConnectInputSerializer(serializers.Serializer):
    target_id = serializers.UUIDField()


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

# Cards per column on the first load; a column pages through ``board/stage`` for the rest and the client
# renders columns windowed, so a 1,000-deal board stays interactive (load-tested in tests/scaling).
BOARD_DEALS_PER_STAGE = 50
BOARD_MAX_PER_STAGE = 500


def _bounded_int(raw: str | None, default: int, maximum: int) -> int:
    try:
        value = int(raw) if raw not in (None, "") else default
    except (TypeError, ValueError) as exc:
        raise serializers.ValidationError({"limit": "Expected a whole number."}) from exc
    return max(0, min(value, maximum))


def validators_uuid(raw: str) -> Any:
    try:
        return serializers.UUIDField().to_internal_value(raw)
    except serializers.ValidationError as exc:
        raise serializers.ValidationError({"id": "Expected a UUID."}) from exc


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
        board_stage="deals.view",
        connections="deals.view",
        connect="deals.update",
        disconnect="deals.update",
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
            .prefetch_related("pipeline", "stage", "price_book")
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

    def board_queryset(self, extra_columns: tuple[str, ...] = ()):
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
                *extra_columns,
            )
            .annotate(
                contact_count=Coalesce(
                    Subquery(contacts.annotate(n=Count("id")).values("n"), output_field=IntegerField()), Value(0)
                ),
                next_activity_title=next_activity_title_subquery("deal"),
            )
        )

    def _board_pipeline(self, request) -> tuple[Pipeline | None, list[Pipeline]]:
        """The board's pipeline and its family (team pipeline + sub-pipelines), within what the actor
        may see (a restricted pipeline answers 404). Pipelines are few: one query reads them all."""
        visible = list(
            scope(request.actor, "pipelines.view", Pipeline.objects.filter(archived_at__isnull=True)).order_by(
                "position", "name"
            )
        )
        pipeline_id = request.query_params.get("pipeline")
        if pipeline_id:
            wanted = validators_uuid(pipeline_id)
            pipeline = next((p for p in visible if p.pk == wanted), None)
            if pipeline is None:
                from django.http import Http404

                raise Http404
        else:
            roots = sorted((p for p in visible if p.parent_id is None), key=lambda p: (not p.is_default, p.position))
            pipeline = roots[0] if roots else None
        if pipeline is None:
            return None, []
        root_id = pipeline.parent_id or pipeline.pk
        family = [p for p in visible if p.pk == root_id] + [p for p in visible if p.parent_id == root_id]
        return pipeline, family

    def _card_fields(self, request, pipeline: Pipeline) -> list:
        """The layout's card fields the actor may see (hidden ones are dropped, not refused)."""
        from apps.crm import schema

        root = (pipeline.parent if pipeline.parent_id else None) or pipeline
        keys = (root.layout or {}).get("card_fields") or []
        if not keys:
            return []
        visible = schema.field_map(request.actor, "deal")
        return [visible[k] for k in keys if k in visible]

    def _board_cards(self, request, pipeline: Pipeline, params: dict) -> Any:
        concrete = {f.name for f in Deal._meta.concrete_fields}
        extra: set[str] = set()
        for f in self._card_fields(request, pipeline):
            if f.custom:
                extra.add("custom_data")
            elif f.key in concrete:
                extra.add(f.key)
        annotated, _ = self.filterset.apply(
            scope(
                request.actor,
                "deals.view",
                self.board_queryset(tuple(sorted(extra))).filter(pipeline=pipeline, archived_at__isnull=True),
            ),
            params,
            actor=request.actor,
        )
        return annotated.prefetch_related(None)

    @action(detail=False, methods=["get"])
    def board(self, request):
        """Kanban payload: stages of one pipeline with the actor's visible deals and per-stage totals.

        ``per_stage`` (default 50, max ``BOARD_MAX_PER_STAGE``) cards per column; a column with more
        reports ``has_more`` and pages through ``board/stage``. Counts, value totals and the weighted
        forecast are computed over every deal in scope, not only the cards sent.
        """
        pipeline, family = self._board_pipeline(request)
        if pipeline is None:
            return Response({"pipeline": None, "stages": []})
        per_stage = _bounded_int(request.query_params.get("per_stage"), BOARD_DEALS_PER_STAGE, BOARD_MAX_PER_STAGE)
        params = {k: v for k, v in request.query_params.items() if k not in {"pipeline", "per_stage"}}
        base = scope(request.actor, "deals.view", Deal.objects.filter(pipeline=pipeline, archived_at__isnull=True))
        base, _ = self.filterset.apply(base, params, actor=request.actor)
        weighted_expr = ExpressionWrapper(
            F("amount_base") * F("probability") / Value(Decimal(100)),
            output_field=DecimalField(max_digits=22, decimal_places=4),
        )
        totals = {
            row["stage_id"]: row
            for row in base.values("stage_id")
            .annotate(total=Sum("amount_base"), weighted=Sum(weighted_expr), count=Count("id"))
            .order_by()
        }
        stages = list(pipeline.stages.filter(archived_at__isnull=True).order_by("position"))
        # One small LIMIT query per stage (index deal_org_stage_entered_idx, annotations evaluated for
        # the returned rows only) instead of ranking every deal of the pipeline and shipping hundreds
        # of ids back to the database. Stages are few; deals are not.
        cards = self._board_cards(request, pipeline, params)
        by_stage: dict = {
            s.pk: list(cards.filter(stage_id=s.pk).order_by("-stage_entered_at", "-id")[:per_stage]) for s in stages
        }
        all_deals = [d for bucket in by_stage.values() for d in bucket]
        # One prefetch for the whole board rather than one per stage bucket.
        prefetch_related_objects(all_deals, "stage")
        # Cards carry no tags and no custom data, so the board needs neither the tag window query that
        # ranked the rendered ids nor the custom-field definitions - two queries and a window scan gone.
        ctx = dict(self.get_serializer_context())
        ctx["card_fields"] = self._card_fields(request, pipeline)
        from apps.authz import fields as field_rules

        # A stage total is the sum of the amounts: hidden with them.
        hide_totals = "amount" in field_rules.hidden_fields(request.actor, "deal")

        def money(value: Any) -> str | None:
            if hide_totals:
                return None
            return str(Decimal(value or 0).quantize(services.CENT))

        payload = []
        open_weighted = Decimal(0)
        open_total = Decimal(0)
        for stage in stages:
            agg = totals.get(stage.pk, {})
            if stage.kind == PipelineStage.Kind.OPEN:
                open_weighted += Decimal(agg.get("weighted") or 0)
                open_total += Decimal(agg.get("total") or 0)
            payload.append(
                {
                    **StageSerializer(stage).data,
                    "deal_count": agg.get("count", 0),
                    "total_amount_base": money(agg.get("total")),
                    "weighted_amount_base": money(agg.get("weighted")),
                    "deals": DealCardSerializer(by_stage[stage.pk], many=True, context=ctx).data,
                    "has_more": agg.get("count", 0) > len(by_stage[stage.pk]),
                }
            )
        root = family[0] if family and family[0].parent_id is None else pipeline
        return Response(
            {
                "pipeline": {
                    "id": str(pipeline.pk),
                    "name": pipeline.name,
                    "parent_id": str(pipeline.parent_id) if pipeline.parent_id else None,
                    "layout": root.layout or {},
                },
                "family": [
                    {"id": str(p.pk), "name": p.name, "parent_id": str(p.parent_id) if p.parent_id else None}
                    for p in family
                ],
                "totals": {
                    "deal_count": sum(int(t.get("count", 0)) for t in totals.values()),
                    "open_amount_base": money(open_total),
                    "weighted_forecast_base": money(open_weighted),
                },
                "stages": payload,
            }
        )

    @action(detail=False, methods=["get"], url_path="board/stage")
    def board_stage(self, request):
        """More cards for one Kanban column: ``?stage=<id>&offset=<n>&limit=<n>`` (same filters as the board)."""
        stage_id = validators_uuid(request.query_params.get("stage", ""))
        stage = get_object_or_404(
            scope(request.actor, "pipelines.view", PipelineStage.objects.filter(archived_at__isnull=True)),
            pk=stage_id,
        )
        offset = _bounded_int(request.query_params.get("offset"), 0, 1_000_000)
        limit = _bounded_int(request.query_params.get("limit"), BOARD_DEALS_PER_STAGE, BOARD_MAX_PER_STAGE)
        params = {k: v for k, v in request.query_params.items() if k not in {"stage", "offset", "limit"}}
        cards = self._board_cards(request, stage.pipeline, params).filter(stage_id=stage.pk)
        rows = list(cards.order_by("-stage_entered_at", "-id")[offset : offset + limit + 1])
        prefetch_related_objects(rows, "stage")
        ctx = dict(self.get_serializer_context())
        ctx["card_fields"] = self._card_fields(request, stage.pipeline)
        return Response(
            {
                "stage_id": str(stage.pk),
                "offset": offset,
                "deals": DealCardSerializer(rows[:limit], many=True, context=ctx).data,
                "has_more": len(rows) > limit,
            }
        )

    # ------------------------------------------------------------------ product lines
    @action(detail=True, methods=["get"])
    def products(self, request, pk=None):
        deal = self.get_object()
        lines = DealProduct.objects.filter(deal=deal).select_related("product")
        ctx = {"actor": request.actor}
        return Response({"results": DealProductSerializer(lines, many=True, context=ctx).data})

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
            expected_version=data.get("version"),
            request=request._request,
        )
        line = DealProduct.objects.select_related("product").get(pk=line.pk)
        return Response(
            DealProductSerializer(line, context={"actor": request.actor}).data, status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=["patch"], url_path=r"products/(?P<line_id>[0-9a-f-]{36})")
    def update_product(self, request, pk=None, line_id=None):
        deal = self.get_object()
        line = get_object_or_404(DealProduct.objects.filter(deal=deal), pk=line_id)
        ser = DealProductInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = {k: v for k, v in ser.validated_data.items() if k not in {"product", "version"}}
        services.update_product_line(
            request.actor,
            deal,
            line,
            expected_version=ser.validated_data.get("version"),
            request=request._request,
            **data,
        )
        line = DealProduct.objects.select_related("product").get(pk=line.pk)
        return Response(DealProductSerializer(line, context={"actor": request.actor}).data)

    @action(detail=True, methods=["post"], url_path=r"products/(?P<line_id>[0-9a-f-]{36})/remove")
    def remove_product(self, request, pk=None, line_id=None):
        deal = self.get_object()
        line = get_object_or_404(DealProduct.objects.filter(deal=deal), pk=line_id)
        version = request.data.get("version") if isinstance(request.data, dict) else None
        services.remove_product(
            request.actor,
            deal,
            line,
            expected_version=int(version) if isinstance(version, int) else None,
            request=request._request,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------ connected deals
    @action(detail=True, methods=["get"])
    def connections(self, request, pk=None):
        """Deals connected to this one, in both directions (only those the actor may view)."""
        deal = self.get_object()
        items = services.connections_for(request.actor, deal)
        return Response({"results": ConnectionSerializer(items, many=True, context={"actor": request.actor}).data})

    @action(detail=True, methods=["post"], url_path="connections/add")
    def connect(self, request, pk=None):
        deal = self.get_object()
        ser = ConnectInputSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        target = (
            scope(request.actor, "deals.view", Deal.objects.filter(pk=ser.validated_data["target_id"]))
            .select_related("pipeline", "stage", "owner__user")
            .first()
        )
        if target is None:
            raise serializers.ValidationError({"target_id": "Unknown deal."})
        link = services.connect_deals(request.actor, deal, target, request=request._request)
        item = {"id": link.pk, "direction": "outgoing", "origin": link.origin, "created_at": link.created_at}
        item["deal"] = target
        return Response(
            ConnectionSerializer(item, context={"actor": request.actor}).data, status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=["post"], url_path=r"connections/(?P<connection_id>[0-9a-f-]{36})/remove")
    def disconnect(self, request, pk=None, connection_id=None):
        deal = self.get_object()
        link = get_object_or_404(
            DealConnection.objects.filter(Q(source=deal) | Q(target=deal)), pk=validators_uuid(connection_id)
        )
        services.disconnect_deals(request.actor, deal, link, request=request._request)
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
