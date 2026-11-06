from django.apps import AppConfig


class DealsConfig(AppConfig):
    name = "apps.deals"
    label = "deals"

    def ready(self) -> None:
        from apps.billing import entitlements

        def _count_records(module: str | None) -> int:
            from apps.deals.models import Deal

            if module not in (None, "deal"):  # asked for another module's share of the record count
                return 0

            # Archived records sit in the recycle bin and do not count towards the plan.
            return Deal.objects.filter(archived_at__isnull=True).count()

        entitlements.register_counter("records", _count_records)

        # Field schema as data (apps.crm.schema): Sheet view, saved views, import and export read it.
        from apps.crm import schema
        from apps.deals.schema import module

        schema.register(module())
