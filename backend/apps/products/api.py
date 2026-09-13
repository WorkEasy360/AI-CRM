from __future__ import annotations

from decimal import Decimal

from rest_framework import serializers

from apps.core import validators
from apps.core.api.crm import CrmViewSet, crud_permission_map
from apps.core.api.filters import Filter, FilterSet
from apps.core.api.serializers import CrmReadSerializer, CustomDataField, owner_field
from apps.core.exceptions import ConflictError
from apps.core.records import RecordSpec
from apps.products.models import Product

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
