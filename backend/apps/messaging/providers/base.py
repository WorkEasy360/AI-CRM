"""Provider adapters. The services only ever talk to these interfaces; HTTP details stay here."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any, Protocol


class ProviderError(Exception):
    """A provider call failed. ``retryable`` decides whether the task retries."""

    def __init__(self, message: str, *, retryable: bool = False, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.retryable = retryable
        self.status = status


@dataclass
class OAuthTokens:
    access_token: str
    refresh_token: str
    expires_at: dt.datetime | None
    email_address: str
    display_name: str = ""
    scopes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SendCapabilities:
    """What a provider can promise about a repeated send.

    ``idempotent_send``  a second call carrying the same key is de-duplicated by the provider and
                         returns the first send's identifiers instead of sending again.
    ``lookup_by_key``    a message already sent with a key can be found again, which is what lets
                         recovery turn "we called the provider and then crashed" into a definite
                         answer instead of a guess.
    """

    idempotent_send: bool = False
    lookup_by_key: bool = False


NO_IDEMPOTENCY = SendCapabilities()


def rfc822_message_id(idempotency_key: str, domain: str = "keel.invalid") -> str:
    """A deterministic RFC 5322 Message-ID for one logical send.

    Derived from the send's idempotency key, so the same logical message always carries the same
    header no matter how many times delivery is retried. Gmail and Microsoft 365 both preserve a
    supplied Message-ID and can search on it, which makes a send reconcilable after a crash.
    """
    return f"<keel-{idempotency_key}@{domain}>"


@dataclass
class OutgoingEmail:
    from_address: str
    to: list[str]
    cc: list[str]
    bcc: list[str]
    subject: str
    body_text: str
    in_reply_to: str = ""
    thread_id: str = ""
    attachments: list[tuple[str, str, bytes]] = field(default_factory=list)  # (filename, content_type, data)
    idempotency_key: str = ""


@dataclass
class SentEmail:
    provider_message_id: str
    provider_thread_id: str


@dataclass
class IncomingEmail:
    provider_message_id: str
    provider_thread_id: str
    from_address: str
    to: list[str]
    subject: str
    body_text: str
    received_at: dt.datetime
    in_reply_to: str = ""


class EmailProviderAdapter(Protocol):
    provider: str
    capabilities: SendCapabilities

    def authorization_url(self, *, state: str, redirect_uri: str, code_challenge: str) -> str: ...

    def exchange_code(self, *, code: str, redirect_uri: str, code_verifier: str) -> OAuthTokens: ...

    def refresh(self, refresh_token: str) -> OAuthTokens: ...

    def send(self, access_token: str, message: OutgoingEmail) -> SentEmail: ...

    def fetch_recent(
        self, access_token: str, *, since: dt.datetime, cursor: str
    ) -> tuple[list[IncomingEmail], str]: ...

    def find_sent(self, access_token: str, idempotency_key: str) -> SentEmail | None:
        """Locate an already-sent message by its idempotency key, or None. Reconciliation only."""
        ...


@dataclass
class OutgoingWhatsApp:
    to: str
    body: str = ""
    template_name: str = ""
    template_language: str = "en"
    template_params: list[str] = field(default_factory=list)
    idempotency_key: str = ""


class WhatsAppProviderAdapter(Protocol):
    capabilities: SendCapabilities

    def send(self, access_token: str, phone_number_id: str, message: OutgoingWhatsApp) -> str: ...

    def verify_account(self, access_token: str, phone_number_id: str) -> dict[str, Any]: ...
