from django.apps import AppConfig


class PipelinesConfig(AppConfig):
    name = "apps.pipelines"
    label = "pipelines"

    def ready(self) -> None:
        from apps.core import domain_events

        def _seed_default_pipeline(event: domain_events.OrganizationCreated) -> None:
            """Every organization starts with a usable sales pipeline.

            Registered here rather than called from apps.accounts: the pipeline module owns the fact
            that a new tenant needs one, and accounts stays below it.
            """
            from apps.pipelines.services import ensure_default_pipeline

            ensure_default_pipeline()

        domain_events.subscribe_bootstrap(_seed_default_pipeline)
