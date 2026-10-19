"""System check for the Workeasy360 sign-in settings that must never be silently weakened."""

from __future__ import annotations

from typing import Any

from django.core.checks import Error, register

from apps.accounts.workeasy360 import config


@register()
def check_product_code(app_configs: Any, **kwargs: Any) -> list[Any]:
    """Where Workeasy360 sign-in is configured the product code must be set: an empty one would switch off
    the comparison of the ID token's ``product_code`` with this product."""
    if not config.is_configured() or config.product_code():
        return []
    return [
        Error(
            "WORKEASY360_PRODUCT_CODE is empty while Workeasy360 sign-in is configured.",
            hint="Leave it unset for the default (easy_crm) or set this product's code; an empty value would "
            "stop ID tokens being checked against the product.",
            id="workeasy360.E001",
        )
    ]
