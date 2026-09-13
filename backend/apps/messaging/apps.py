from django.apps import AppConfig


class MessagingConfig(AppConfig):
    name = "apps.messaging"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        from apps.messaging import timeline_provider  # noqa: F401  (registers email/WhatsApp timeline providers)
