from django.apps import AppConfig


class ProductsConfig(AppConfig):
    name = "apps.products"
    label = "products"

    def ready(self) -> None:
        from apps.billing import entitlements

        def _count_records(module: str | None) -> int:
            from apps.products.models import Product

            if module not in (None, "product"):  # asked for another module's share of the record count
                return 0

            # Archived records sit in the recycle bin and do not count towards the plan.
            return Product.objects.filter(archived_at__isnull=True).count()

        entitlements.register_counter("records", _count_records)

        # Field schema as data (apps.crm.schema): Sheet view, saved views, import and export read it.
        from apps.crm import schema
        from apps.products.schema import module

        schema.register(module())
