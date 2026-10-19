from django.apps import AppConfig


class BillingConfig(AppConfig):
    name = "apps.billing"
    label = "billing"

    def ready(self) -> None:
        from apps.core import domain_events

        def _start_subscription(event: domain_events.OrganizationCreated) -> None:
            """Every new organization starts on the trial (or, with billing off, the full product)."""
            from apps.billing.services import start_subscription

            start_subscription()

        domain_events.subscribe_bootstrap(_start_subscription)
