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

        from apps.billing import entitlements

        def _count_pipelines(_module: str | None) -> int:
            from apps.pipelines.models import Pipeline

            # Sub-pipelines are variants of a team pipeline, not team pipelines (DECISIONS M2.4).
            return Pipeline.objects.filter(archived_at__isnull=True, parent__isnull=True).count()

        entitlements.register_counter("pipelines", _count_pipelines)

        # Restricted team pipelines hide themselves and their deals from members outside their grants.
        from apps.pipelines import access

        access.register()
