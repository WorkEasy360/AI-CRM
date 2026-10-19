"""Workeasy360 sign-in configuration, read from settings at call time (so ``override_settings`` works).

The client is cached per configuration so the discovery document and key set it caches survive from
one request to the next; a configuration change (or a test's fake transport) builds a fresh one.
"""

from __future__ import annotations

import functools
import threading
from pathlib import Path

from django.conf import settings

from apps.accounts.workeasy360.oidc import (
    ENTITLEMENT_TIMEOUT_SECONDS,
    SSOError,
    Transport,
    Workeasy360Client,
    httpx_transport,
)
from apps.authz.reauth import WORKEASY360_METHOD

#: Value recorded in allauth's authentication log for a Workeasy360 sign-in (``record_authentication``).
AUTH_METHOD = WORKEASY360_METHOD

#: Tests replace this with a fake transport; production always uses httpx.
transport_override: Transport | None = None

_lock = threading.Lock()
_cached: tuple[tuple, Workeasy360Client] | None = None


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
    see ``checks.check_product_code`` and ``provisioning.read_claims``."""
    return str(settings.WORKEASY360_PRODUCT_CODE or "").strip()


def post_logout_redirect_uri() -> str:
    """Where Workeasy360 returns the browser after "sign out of Workeasy360 too" - registered for
    this client in Workeasy360 exactly. Empty: the option is not offered."""
    return str(getattr(settings, "WORKEASY360_POST_LOGOUT_REDIRECT_URI", "") or "")


def sign_out_of_workeasy360_available() -> bool:
    return is_configured() and bool(post_logout_redirect_uri())


def _private_key() -> str:
    if settings.WORKEASY360_PRIVATE_KEY:
        return str(settings.WORKEASY360_PRIVATE_KEY)
    try:
        return Path(settings.WORKEASY360_PRIVATE_KEY_FILE).read_text(encoding="utf-8")
    except OSError as exc:
        raise SSOError("provider_misconfigured", f"cannot read WORKEASY360_PRIVATE_KEY_FILE: {exc}") from None


def get_client() -> Workeasy360Client:
    global _cached
    if not is_configured():
        raise SSOError("provider_misconfigured", "Workeasy360 sign-in is not configured")
    transport = transport_override or httpx_transport
    key = (
        settings.WORKEASY360_ISSUER,
        settings.WORKEASY360_CLIENT_ID,
        settings.WORKEASY360_REDIRECT_URI,
        settings.WORKEASY360_KEY_ID,
        settings.WORKEASY360_PRIVATE_KEY,
        settings.WORKEASY360_PRIVATE_KEY_FILE,
        settings.WORKEASY360_SCOPES,
        transport,
    )
    with _lock:
        if _cached is not None and _cached[0] == key:
            return _cached[1]
    client = Workeasy360Client(
        issuer=settings.WORKEASY360_ISSUER,
        client_id=settings.WORKEASY360_CLIENT_ID,
        redirect_uri=settings.WORKEASY360_REDIRECT_URI,
        private_key_pem=_private_key(),
        key_id=settings.WORKEASY360_KEY_ID,
        scopes=tuple(str(settings.WORKEASY360_SCOPES).split()),
        transport=transport,
        # A test's fake transport answers everything; production gives the entitlement call a shorter timeout.
        entitlement_transport=None
        if transport_override
        else functools.partial(httpx_transport, timeout=ENTITLEMENT_TIMEOUT_SECONDS),
    )
    with _lock:
        _cached = (key, client)
    return client
