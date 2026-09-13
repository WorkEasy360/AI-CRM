from django.apps import AppConfig


class ActivitiesConfig(AppConfig):
    name = "apps.activities"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        from apps.activities import timeline_provider  # noqa: F401  (registers the timeline provider)
