"""``settings.WORKEASY360_SSO`` for the workeasy360-sso connector, derived from Keel's own settings.

Keel's ``WORKEASY360_*`` settings (and the environment / SSM parameter names behind them) stay what they
always were; the connector reads its configuration from this mapping, which is computed from them each time
the connector (re)loads its configuration. So ``override_settings(WORKEASY360_ISSUER=...)`` reaches the
connector too (``config`` resets the connector's cache when a ``WORKEASY360_*`` setting changes).

Imported from the settings module: no app imports here.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

#: The backend Keel's password and passkey sign-ins use. A Workeasy360 sign-in is recorded under the same
#: one, so a session looks the same whichever way the person came in - and sessions opened before the
#: connector existed keep working unchanged.
LOGIN_BACKEND = "allauth.account.auth_backends.AuthenticationBackend"

#: Refusals Keel's own rules produce that the connector's vocabulary has no word for. The messages are what
#: the connector's own pages would show; Keel's frontend shows its own (frontend/src/lib/auth-methods.ts).
ERROR_MESSAGES = {
    "organization_unavailable": "This organization is not available in WorkEasyCRM. Contact your administrator.",
    "seat_limit": "This organization has no free WorkEasyCRM seats. Ask an administrator to free one up.",
    "reauthentication_wrong_account": (
        "That was a different Workeasy360 account. Confirm with the account you use in WorkEasyCRM."
    ),
}


def connector_settings() -> dict[str, Any]:
    from django.conf import settings

    return {
        "ISSUER": settings.WORKEASY360_ISSUER,
        "CLIENT_ID": settings.WORKEASY360_CLIENT_ID,
        "REDIRECT_URI": settings.WORKEASY360_REDIRECT_URI,
        "PRODUCT_CODE": settings.WORKEASY360_PRODUCT_CODE,
        "KEY_ID": settings.WORKEASY360_KEY_ID,
        "PRIVATE_KEY": settings.WORKEASY360_PRIVATE_KEY,
        "PRIVATE_KEY_FILE": settings.WORKEASY360_PRIVATE_KEY_FILE,
        # private_key_jwt only; the signing algorithm follows the key (RS256 for RSA, ES256 for EC P-256).
        "CLIENT_SECRET": "",  # nosec B105 - empty: no client secret, Keel authenticates with private_key_jwt
        "SIGNING_ALGORITHM": "",
        "SCOPES": settings.WORKEASY360_SCOPES,
        "POST_LOGOUT_REDIRECT_URI": settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI,
        "SSO_ONLY": settings.WORKEASY360_SSO_ONLY,
        # The Next.js frontend starts sign-ins itself (AuthGate, launcher); Django only serves /api/.
        "AUTO_START": False,
        "BACKCHANNEL_LOGOUT": getattr(settings, "WORKEASY360_BACKCHANNEL_LOGOUT", True),
        "API_PATH_PREFIXES": ("/api/", "/_allauth/"),
        "PUBLIC_PATHS": (),
        "LOGIN_URL": "/login",
        "LOGIN_REDIRECT_URL": "/",
        "LOGOUT_REDIRECT_URL": "/login",
        "ERROR_REDIRECT_URL": "/login",
        "PURCHASE_URL": "",
        # A person watches the sign-in; a request (inside its transaction) or a job waits on entitlement.
        "HTTP_TIMEOUT": 10,
        "ENTITLEMENT_TIMEOUT": 5,
        "LEEWAY": 30,
        "FLOW_TTL": 600,
        "DISCOVERY_TTL": 3600,
        "USER_ADAPTER": "apps.accounts.workeasy360.provisioning.UserAdapter",
        "ORGANIZATION_ADAPTER": "apps.accounts.workeasy360.provisioning.OrganizationAdapter",
        # Keel's adapters apply Keel's linking and profile rules themselves.
        "LINK_BY_VERIFIED_EMAIL": False,
        "SYNC_PROFILE": False,
        "CACHE_ALIAS": "default",
        "ALLOW_INSECURE_HTTP": getattr(settings, "WORKEASY360_ALLOW_INSECURE_HTTP", False),
        "EXPOSE_STATUS": False,
        "HTTP_TRANSPORT": getattr(settings, "WORKEASY360_HTTP_TRANSPORT", None),
        "LOGIN_BACKEND": LOGIN_BACKEND,
        "ERROR_MESSAGES": ERROR_MESSAGES,
        # Celery's "time is up" is not an outage of Workeasy360, and not the connector's to swallow.
        "PROPAGATE_EXCEPTIONS": ("celery.exceptions.SoftTimeLimitExceeded",),
    }


class ConnectorSettings(Mapping[str, Any]):
    """A read-only view of :func:`connector_settings`, evaluated when the connector reads it."""

    def __getitem__(self, key: str) -> Any:
        return connector_settings()[key]

    def __iter__(self) -> Iterator[str]:
        return iter(connector_settings())

    def __len__(self) -> int:
        return len(connector_settings())

    def __repr__(self) -> str:
        return "<ConnectorSettings derived from WORKEASY360_* (secrets not shown)>"
