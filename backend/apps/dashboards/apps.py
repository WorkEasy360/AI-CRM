from django.apps import AppConfig


class DashboardsConfig(AppConfig):
    name = "apps.dashboards"
    label = "dashboards"

    def ready(self) -> None:
        from apps.core import domain_events
        from apps.dashboards import cache

        def _invalidate(event: domain_events.RecordChanged) -> None:
            cache.invalidate(event.organization_id)

        # best effort: a dashboard counter that could not be bumped must never fail a customer's save.
        # The per-entry TTL bounds how long a missed bump can show stale numbers.
        domain_events.subscribe(_invalidate, critical=False)
