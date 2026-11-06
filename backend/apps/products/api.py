from __future__ import annotations

from decimal import Decimal

from rest_framework import mixins, serializers, status
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.core import validators
from apps.core.api.crm import CrmViewSet, crud_permission_map
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import CrmReadSerializer, CustomDataField, owner_field
from apps.core.api.viewsets import TenantViewSet
from apps.core.concurrency import expected_version
from apps.core.exceptions import ConflictError
from apps.crm.records import RecordSpec
from apps.products import services
from apps.products.models import PriceBook, PriceBookEntry, Product

SPEC = RecordSpec(module="products", entity_type="product", model=Product, display=lambda p: p.name)


class ProductSerializer(CrmReadSerializer):
    entity_type = "product"

    class Meta:
        model = Product
        fields = [
            "id",
            "name",
            "sku",
            "description",
            "unit_price",
            "currency",
            "tax_rate",
            "tax_label",
            "status",
            "in_stock",
            "owner",
            "tags",
            "custom_data",
            "version",
            "archived_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class ProductWriteSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=160)
    sku = serializers.CharField(max_length=64, required=False, allow_blank=True)
    description = serializers.CharField(max_length=5000, required=False, allow_blank=True)
    unit_price = serializers.DecimalField(max_digits=18, decimal_places=2, required=False)
    currency = serializers.CharField(max_length=3, required=False)
    tax_rate = serializers.DecimalField(max_digits=5, decimal_places=2, required=False)
    tax_label = serializers.CharField(max_length=40, required=False, allow_blank=True)
    status = serializers.ChoiceField(choices=Product.Status.choices, required=False)
    in_stock = serializers.BooleanField(required=False)
    owner_id = owner_field()
    custom_data = CustomDataField("product")

    def validate_name(self, value: str) -> str:
        value = validators.clean_text(value, max_length=160)
        if not value:
            raise serializers.ValidationError("Name is required.")
        return value

    def validate_sku(self, value: str) -> str:
        value = validators.clean_text(value, max_length=64)
        if value and not all(c.isalnum() or c in "-_./" for c in value):
            raise serializers.ValidationError("SKU may contain letters, digits, '-', '_', '.' and '/'.")
        return value

    def validate_description(self, value: str) -> str:
        return validators.clean_text(value, max_length=5000, allow_newlines=True)

    def validate_unit_price(self, value: Decimal) -> Decimal:
        return validators.clean_amount(value) or Decimal("0.00")

    def validate_tax_rate(self, value: Decimal) -> Decimal:
        if value < 0 or value > 100:
            raise serializers.ValidationError("Tax rate must be between 0 and 100.")
        return value

    def validate_tax_label(self, value: str) -> str:
        return validators.clean_text(value, max_length=40)

    def validate_currency(self, value: str) -> str:
        return validators.clean_currency(value, default="")

    def validate(self, attrs):
        if self.instance is None and "currency" not in attrs:
            attrs["currency"] = self.context["actor"].organization.base_currency
        sku = attrs.get("sku")
        if sku:
            qs = Product.objects.filter(sku=sku)
            if self.instance is not None:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise ConflictError("A product with this SKU already exists.", code="sku_taken")
        return attrs


FILTERS = FilterSet(
    filters={
        "owner": Filter("owner", "owner_id"),
        "status": Filter("choice", "status", choices=tuple(Product.Status.values)),
        "currency": Filter("exact", "currency", max_length=3),
        "price_min": Filter("decimal_min", "unit_price"),
        "in_stock": Filter("bool", "in_stock"),
        "price_max": Filter("decimal_max", "unit_price"),
        "ids": Filter("uuid_list", "id"),
    },
    sort_fields={
        "name": "name",
        "sku": "sku",
        "unit_price": "unit_price",
        "created_at": "created_at",
        "updated_at": "updated_at",
    },
    default_sort="name",
    search_fields=("name", "sku", "description"),
    custom_field_entity="product",
)


class ProductViewSet(CrmViewSet):
    spec = SPEC
    filterset = FILTERS
    serializer_class = ProductSerializer
    write_serializer_class = ProductWriteSerializer
    permission_map = {k: v for k, v in crud_permission_map("products").items() if k != "bulk"}

    def bulk(self, request):  # products have no bulk_update permission in the catalogue
        from rest_framework.exceptions import MethodNotAllowed

        raise MethodNotAllowed("POST")


# ----------------------------------------------------------------------------- price books


class PriceBookSerializer(serializers.ModelSerializer):
    entry_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = PriceBook
        fields = [
            "id",
            "name",
            "currency",
            "description",
            "is_active",
            "entry_count",
            "version",
            "archived_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class PriceBookWriteSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80, required=False)
    currency = serializers.CharField(max_length=3, required=False)
    description = serializers.CharField(max_length=255, required=False, allow_blank=True)
    is_active = serializers.BooleanField(required=False)


class PriceBookEntrySerializer(serializers.ModelSerializer):
    product = serializers.SerializerMethodField()
    list_price = serializers.DecimalField(source="product.unit_price", max_digits=18, decimal_places=2, read_only=True)

    class Meta:
        model = PriceBookEntry
        fields = ["id", "product", "unit_price", "list_price", "updated_at"]
        read_only_fields = fields

    def get_product(self, obj: PriceBookEntry) -> dict:
        return {"id": str(obj.product_id), "name": obj.product.name, "sku": obj.product.sku}

    def to_representation(self, instance: PriceBookEntry) -> dict:
        from apps.authz import fields as field_rules

        data = super().to_representation(instance)
        # A price-book price is a product price: hidden wherever the product's unit price is.
        if "unit_price" in field_rules.hidden_fields(self.context.get("actor"), "product"):
            data.pop("unit_price", None)
            data.pop("list_price", None)
        return data


class PriceBookEntryInputSerializer(serializers.Serializer):
    product_id = serializers.UUIDField()
    unit_price = serializers.DecimalField(max_digits=18, decimal_places=2, min_value=0, allow_null=True)


class PriceBookEntriesSerializer(serializers.Serializer):
    entries = serializers.ListField(child=PriceBookEntryInputSerializer(), max_length=services.MAX_ENTRIES_PER_REQUEST)


class PriceBookViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, TenantViewSet):
    """Price books (``products.view`` to read, ``pricebooks.manage`` to change)."""

    serializer_class = PriceBookSerializer
    resolved_ordering = ("name", "id")
    permission_map = {
        "list": "products.view",
        "retrieve": "products.view",
        "create": "pricebooks.manage",
        "partial_update": "pricebooks.manage",
        "destroy": "pricebooks.manage",
        "entries": "products.view",
        "set_entries": "pricebooks.manage",
    }

    def base_queryset(self):
        from django.db.models import Count

        qs = PriceBook.objects.annotate(entry_count=Count("entries"))
        if self.action == "list" and self.request.query_params.get("archived", "").lower() not in {"true", "1"}:
            qs = qs.filter(archived_at__isnull=True)
        return qs.order_by("name")

    def _read(self, book: PriceBook) -> dict:
        return PriceBookSerializer(self.base_queryset().get(pk=book.pk)).data

    def create(self, request):
        ser = PriceBookWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        if not ser.validated_data.get("name"):
            raise serializers.ValidationError({"name": "Name is required."})
        book = services.create_price_book(
            request.actor,
            name=ser.validated_data["name"],
            currency=ser.validated_data.get("currency", ""),
            description=ser.validated_data.get("description", ""),
            request=request._request,
        )
        return Response(self._read(book), status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        book = self.get_object()
        ser = PriceBookWriteSerializer(data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        version = expected_version(request._request, request.data, required=False)
        services.update_price_book(
            request.actor, book, expected_version=version, request=request._request, **ser.validated_data
        )
        return Response(self._read(book))

    def destroy(self, request, pk=None):
        book = self.get_object()
        services.archive_price_book(request.actor, book, request=request._request)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"])
    def entries(self, request, pk=None):
        book = self.get_object()
        rows = PriceBookEntry.objects.filter(price_book=book).select_related("product").order_by("product__name")
        return Response({"results": PriceBookEntrySerializer(rows, many=True, context={"actor": request.actor}).data})

    @action(detail=True, methods=["put"], url_path="entries/set")
    def set_entries(self, request, pk=None):
        book = self.get_object()
        ser = PriceBookEntriesSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        rows = services.set_entries(
            request.actor, book, entries=ser.validated_data["entries"], request=request._request
        )
        return Response({"results": PriceBookEntrySerializer(rows, many=True, context={"actor": request.actor}).data})
