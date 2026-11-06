from django.apps import AppConfig


class CustomFieldsConfig(AppConfig):
    name = "apps.customfields"
    label = "customfields"
    verbose_name = "Custom fields"

    def ready(self) -> None:
        from apps.billing import entitlements

        def _count_fields(module: str | None) -> int:
            from apps.customfields.models import CustomFieldDefinition

            qs = CustomFieldDefinition.objects.filter(archived_at__isnull=True)
            return qs.filter(entity_type=module).count() if module else qs.count()

        entitlements.register_counter("custom_fields", _count_fields)
