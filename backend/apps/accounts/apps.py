from django.apps import AppConfig


class AccountsConfig(AppConfig):
    name = "apps.accounts"
    label = "accounts"
    verbose_name = "Accounts"

    def ready(self) -> None:
        from apps.accounts import signals  # noqa: F401 - connect handlers
        from apps.accounts.workeasy360 import checks  # noqa: F401 - register the system check
        from apps.billing import entitlements

        def _count_seats(_module: str | None) -> int:
            from apps.accounts.limits import seats_in_use

            return seats_in_use()

        entitlements.register_counter("users", _count_seats)
