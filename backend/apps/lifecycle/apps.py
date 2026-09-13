from django.apps import AppConfig


class LifecycleConfig(AppConfig):
    name = "apps.lifecycle"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        from apps.lifecycle import timeline_provider  # noqa: F401  (registers the timeline provider)
