"""Workeasy360 sign-in configuration, read from settings at call time (so ``override_settings`` works).

The protocol itself - discovery, the key set, client authentication, the authorization code flow, ID and
logout token verification, entitlement HTTP and caching - is the workeasy360-sso connector's. It reads its
configuration from ``settings.WORKEASY360_SSO``, which ``connector_settings`` derives from the
``WORKEASY360_*`` settings below; a change to any of them (a test's ``settings`` fixture) resets the
connector's cached configuration and provider metadata.
"""

from __future__ import annotations

from typing import Any

from django.conf import settings
from django.core.signals import setting_changed
from django.dispatch import receiver
from workeasy360_sso import discovery
from workeasy360_sso.conf import SSOConfig, get_config, reset_config

from apps.authz.reauth import WORKEASY360_METHOD

#: Value recorded in allauth's authentication log for a Workeasy360 sign-in (``record_authentication``).
AUTH_METHOD = WORKEASY360_METHOD


def sso_only() -> bool:
    """True when Workeasy360 is the only way in (password sign-in, sign-up and reset are refused)."""
    return bool(getattr(settings, "WORKEASY360_SSO_ONLY", False))


def password_sign_in_enabled() -> bool:
    return not sso_only()


def is_configured() -> bool:
    """Workeasy360 sign-in is offered only when everything the flow needs is present."""
    return bool(
        settings.WORKEASY360_ISSUER
        and settings.WORKEASY360_CLIENT_ID
        and settings.WORKEASY360_REDIRECT_URI
        and settings.WORKEASY360_KEY_ID
        and (settings.WORKEASY360_PRIVATE_KEY or settings.WORKEASY360_PRIVATE_KEY_FILE)
    )


def issuer() -> str:
    return str(settings.WORKEASY360_ISSUER)


def product_code() -> str:
    """The product an ID token must name (``product_code``). Blank is a misconfiguration, never "check nothing":
    see ``checks.check_product_code``; the connector refuses every sign-in (``unavailable``) meanwhile."""
    return str(settings.WORKEASY360_PRODUCT_CODE or "").strip()


def post_logout_redirect_uri() -> str:
    """Where Workeasy360 returns the browser after "sign out of Workeasy360 too" - registered for
    this client in Workeasy360 exactly. Empty: the option is not offered."""
    return str(getattr(settings, "WORKEASY360_POST_LOGOUT_REDIRECT_URI", "") or "")


def sign_out_of_workeasy360_available() -> bool:
    return is_configured() and bool(post_logout_redirect_uri())


def connector() -> SSOConfig:
    """The connector's configuration (built from the settings above, cached until one changes)."""
    return get_config()


@receiver(setting_changed)
def _reset_connector(*, setting: str, **_: Any) -> None:
    if setting.startswith("WORKEASY360_"):
        reset_config()
        discovery.reset_cache()
