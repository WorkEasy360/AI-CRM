from django.apps import AppConfig


class NotesConfig(AppConfig):
    name = "apps.notes"
    label = "notes"

    def ready(self) -> None:
        from apps.notes import field_changes  # noqa: F401  (registers the audit-backed timeline provider)
