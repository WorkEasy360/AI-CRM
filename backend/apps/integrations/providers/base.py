"""The provider contract. CRM apps never talk to external systems directly; they go through a provider.

A provider is stateless: everything it needs arrives in a ``ProviderContext`` (the connection row and
its decrypted credentials). Providers raise ``ProviderError`` with a stable ``code``; the hub turns
codes into human messages (``apps.integrations.errors``) and keeps provider text out of the UI.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar

from django.utils import timezone

if TYPE_CHECKING:
    from apps.integrations.models import IntegrationConnection


class ProviderError(Exception):
    """A provider operation failed.

    ``retryable``: a later attempt may succeed (429, 5xx, timeouts).
    ``action_required``: a person must fix something (expired/revoked credentials) before retrying.
    """

    def __init__(
        self,
        code: str,
        *,
        retryable: bool = False,
        action_required: bool = False,
        retry_after: int | None = None,
        status: int | None = None,
    ):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.action_required = action_required
        self.retry_after = retry_after
        self.status = status


class NotSupported(ProviderError):  # noqa: N818
    def __init__(self, operation: str):
        super().__init__(f"not_supported:{operation}")


@dataclass
class HealthResult:
    ok: bool
    code: str = ""
    checked_at: dt.datetime = field(default_factory=timezone.now)


@dataclass
class ExternalRecord:
    external_id: str
    values: dict[str, Any]
    updated_at: dt.datetime | None = None


@dataclass
class PullPage:
    records: list[ExternalRecord]
    next_cursor: str | None = None


@dataclass
class PushResult:
    external_id: str


@dataclass
class ProviderContext:
    connection: IntegrationConnection
    credentials: dict[str, Any]

    def save_credentials(self, updates: dict[str, Any], *, expires_at: dt.datetime | None = None) -> None:
        """Persist refreshed credentials (encrypted) without touching anything else on the row."""
        from apps.integrations import credentials as sealed
        from apps.integrations.models import IntegrationConnection

        self.credentials.update(updates)
        self.connection.credentials_enc = sealed.seal(self.credentials)
        fields = {"credentials_enc": self.connection.credentials_enc, "updated_at": timezone.now()}
        if expires_at is not None:
            self.connection.token_expires_at = expires_at
            fields["token_expires_at"] = expires_at
        IntegrationConnection.objects.filter(pk=self.connection.pk).update(**fields)


class IntegrationProvider:
    key: ClassVar[str]
    name: ClassVar[str]
    description: ClassVar[str]
    category: ClassVar[str] = "general"
    auth_types: ClassVar[tuple[str, ...]] = ()
    # Hub-managed connections live in IntegrationConnection; "managed elsewhere" providers keep their
    # own tables (apps.messaging) and settings page, and the hub only summarizes and links to them.
    managed_elsewhere: ClassVar[str | None] = None
    supports_sync: ClassVar[bool] = False
    supports_inbound_webhooks: ClassVar[bool] = False

    # --- connection lifecycle
    def connect(self, ctx: ProviderContext) -> HealthResult:
        """Called after credentials/config are stored: verify them (and obtain tokens when needed)."""
        return self.test_connection(ctx)

    def authorization_url(self, ctx: ProviderContext, *, state: str, redirect_uri: str, code_challenge: str) -> str:
        raise NotSupported("oauth")

    def complete_authorization(self, ctx: ProviderContext, *, code: str, redirect_uri: str, code_verifier: str) -> None:
        raise NotSupported("oauth")

    def disconnect(self, ctx: ProviderContext) -> None:
        """Revoke remote credentials where the provider supports it. Best effort; never raises."""

    def refresh_credentials(self, ctx: ProviderContext) -> None:
        """Refresh short-lived tokens if needed."""

    def test_connection(self, ctx: ProviderContext) -> HealthResult:
        raise NotSupported("test")

    def health(self, ctx: ProviderContext) -> HealthResult:
        conn = ctx.connection
        return HealthResult(ok=not conn.last_error_code, code=conn.last_error_code)

    # --- data exchange
    def pull(
        self, ctx: ProviderContext, entity_type: str, *, resource: str, cursor: str | None, since: dt.datetime | None
    ) -> PullPage:
        raise NotSupported("pull")

    def push(
        self,
        ctx: ProviderContext,
        entity_type: str,
        *,
        resource: str,
        values: dict[str, Any],
        external_id: str | None,
        idempotency_key: str,
    ) -> PushResult:
        raise NotSupported("push")

    def handle_webhook(self, ctx: ProviderContext, payload: dict[str, Any]) -> list[tuple[str, ExternalRecord]]:
        raise NotSupported("webhook")
