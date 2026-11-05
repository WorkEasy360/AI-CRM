from django.apps import AppConfig


class AutomationConfig(AppConfig):
    name = "apps.automation"
    label = "automation"

    def ready(self) -> None:
        from apps.automation import engine
        from apps.billing import entitlements
        from apps.core import domain_events

        def _count_rules(module: str | None) -> int:
            from apps.automation.models import AutomationRule

            return AutomationRule.objects.count()

        entitlements.register_counter("automation_rules", _count_rules)
        # Best effort: a rule that could not be queued must never fail the customer's save.
        domain_events.subscribe(engine.on_record_changed, critical=False)
