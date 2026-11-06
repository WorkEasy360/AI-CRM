"""Product fields as data (apps.crm.schema). Registered from ``ProductsConfig.ready()``."""

from __future__ import annotations

from apps.crm import schema as s


def _binding() -> s.Binding:
    from apps.crm import records
    from apps.products.api import FILTERS, SPEC, ProductViewSet, ProductWriteSerializer

    def create(actor, data, *, request=None):
        return records.create(actor, SPEC, data, request=request)

    def update(actor, obj, data, *, expected_version, request=None):
        return records.update(actor, SPEC, obj, data, expected_version=expected_version, request=request)

    return s.Binding(
        spec=SPEC,
        write_serializer=ProductWriteSerializer,
        filterset=FILTERS,
        queryset=lambda: ProductViewSet().base_queryset(),
        create=create,
        update=update,
    )


def module() -> s.ModuleDef:
    from apps.products.models import Product

    return s.ModuleDef(
        entity_type="product",
        module="products",
        label="Product",
        label_plural="Products",
        binding=_binding,
        dedupe_keys=(("sku",), ("name",)),
        default_columns=("name", "sku", "unit_price", "tax_rate", "status", "in_stock"),
        fields=(
            s.FieldDef("name", "Name", s.TEXT, required=True, sort="name"),
            s.FieldDef("sku", "SKU", s.TEXT, sort="sku"),
            s.FieldDef("unit_price", "Unit price", s.MONEY, sort="unit_price", currency_field="currency"),
            s.FieldDef("currency", "Currency", s.TEXT, groupable=True),
            s.FieldDef("tax_rate", "Tax rate", s.PERCENT),
            s.FieldDef("tax_label", "Tax label", s.TEXT),
            s.FieldDef("status", "Status", s.CHOICE, choices=tuple(Product.Status.values), groupable=True),
            s.FieldDef("in_stock", "In stock", s.BOOLEAN, groupable=True),
            s.FieldDef("description", "Description", s.TEXTAREA),
            s.FieldDef("owner", "Owner", s.USER, write_key="owner_id", groupable=True, importable=False),
            s.FieldDef("tags", "Tags", s.TAGS, editable=False, importable=False),
            s.FieldDef("created_at", "Created", s.DATETIME, editable=False, sort="created_at", importable=False),
            s.FieldDef("updated_at", "Updated", s.DATETIME, editable=False, sort="updated_at", importable=False),
        ),
    )
