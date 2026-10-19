from django.apps import AppConfig


class CompaniesConfig(AppConfig):
    name = "apps.companies"
    label = "companies"

    def ready(self) -> None:
        from apps.billing import entitlements

        def _count_records(module: str | None) -> int:
            from apps.companies.models import Company

            if module not in (None, "company"):  # asked for another module's share of the record count
                return 0

            # Archived records sit in the recycle bin and do not count towards the plan.
            return Company.objects.filter(archived_at__isnull=True).count()

        entitlements.register_counter("records", _count_records)

        # Field schema as data (apps.crm.schema): Sheet view, saved views, import and export read it.
        from apps.companies.schema import module
        from apps.crm import schema

        schema.register(module())
