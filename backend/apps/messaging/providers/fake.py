"""Deterministic in-memory providers for tests and local development (``MESSAGING_PROVIDER_BACKEND=fake``)."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any, ClassVar

from django.utils import timezone

from apps.messaging.providers.base import (
    NO_IDEMPOTENCY,
    IncomingEmail,
    OAuthTokens,
    OutgoingEmail,
    OutgoingWhatsApp,
    ProviderError,
    SendCapabilities,
    SentEmail,
)


class FakeEmailProvider:
    """Records every call; ``inbox`` can be pre-loaded to simulate replies during sync.

    Stands in for a provider that de-duplicates: a second ``send`` carrying an idempotency key
    already seen returns the first send's identifiers without appending to ``sent``. Tests assert
    against ``sent`` to prove that a duplicated task never puts a second message on the wire.
    """

    sent: list[OutgoingEmail] = []
    inbox: list[IncomingEmail] = []
    fail_next_send: bool = False
    crash_next_send: bool = False
    by_key: ClassVar[dict[str, SentEmail]] = {}
    capabilities = SendCapabilities(idempotent_send=True, lookup_by_key=True)

    def __init__(self, provider: str = "gmail") -> None:
        self.provider = provider

    def authorization_url(self, *, state: str, redirect_uri: str, code_challenge: str) -> str:
        return f"https://fake.example/oauth?state={state}&redirect_uri={redirect_uri}&cc={code_challenge}"

    def exchange_code(self, *, code: str, redirect_uri: str, code_verifier: str) -> OAuthTokens:
        if code == "bad":
            raise ProviderError("invalid code")
        return OAuthTokens(
            access_token=f"access-{code}",
            refresh_token=f"refresh-{code}",
            expires_at=timezone.now() + dt.timedelta(hours=1),
            email_address=f"{code}@example.com" if "@" not in code else code,
            display_name="Fake User",
            scopes=["mail.send", "mail.read"],
        )

    def refresh(self, refresh_token: str) -> OAuthTokens:
        return OAuthTokens(
            access_token=f"access-refreshed-{uuid.uuid4().hex[:6]}",
            refresh_token=refresh_token,
            expires_at=timezone.now() + dt.timedelta(hours=1),
            email_address="",
        )

    def send(self, access_token: str, message: OutgoingEmail) -> SentEmail:
        if FakeEmailProvider.fail_next_send:
            FakeEmailProvider.fail_next_send = False
            raise ProviderError("provider rejected the message", retryable=False)
        key = message.idempotency_key
        if key and key in FakeEmailProvider.by_key:
            return FakeEmailProvider.by_key[key]  # the provider de-duplicates; nothing new is sent
        FakeEmailProvider.sent.append(message)
        mid = f"fake-{uuid.uuid4().hex}"
        result = SentEmail(provider_message_id=mid, provider_thread_id=message.thread_id or f"thread-{mid}")
        if key:
            FakeEmailProvider.by_key[key] = result
        if FakeEmailProvider.crash_next_send:
            # The provider accepted the message and *then* the worker died: the exact window the
            # reconciliation sweeper exists for. The recorded send stands, the caller never learns it.
            FakeEmailProvider.crash_next_send = False
            raise RuntimeError("worker crashed after the provider accepted the message")
        return result

    def find_sent(self, access_token: str, idempotency_key: str) -> SentEmail | None:
        return FakeEmailProvider.by_key.get(idempotency_key)

    def fetch_recent(self, access_token: str, *, since: dt.datetime, cursor: str) -> tuple[list[IncomingEmail], str]:
        items = [m for m in FakeEmailProvider.inbox if m.received_at >= since]
        return items, f"cursor-{len(FakeEmailProvider.inbox)}"

    @classmethod
    def reset(cls) -> None:
        cls.sent = []
        cls.inbox = []
        cls.fail_next_send = False
        cls.crash_next_send = False
        cls.by_key = {}


class FakeWhatsAppProvider:
    """Mirrors the real Cloud API: no idempotency key, no lookup. Recovery must not replay a send."""

    sent: list[OutgoingWhatsApp] = []
    fail_next_send: bool = False
    crash_next_send: bool = False
    capabilities = NO_IDEMPOTENCY

    def send(self, access_token: str, phone_number_id: str, message: OutgoingWhatsApp) -> str:
        if FakeWhatsAppProvider.fail_next_send:
            FakeWhatsAppProvider.fail_next_send = False
            raise ProviderError("provider rejected the message")
        FakeWhatsAppProvider.sent.append(message)
        if FakeWhatsAppProvider.crash_next_send:
            FakeWhatsAppProvider.crash_next_send = False
            raise RuntimeError("worker crashed after the provider accepted the message")
        return f"wamid.{uuid.uuid4().hex}"

    def verify_account(self, access_token: str, phone_number_id: str) -> dict[str, Any]:
        if not access_token or access_token == "bad":  # noqa: S105 - test sentinel, not a secret  # nosec B105 - not a secret
            raise ProviderError("invalid token", status=401)
        return {"display_phone_number": "+1 555 0100", "verified_name": "Fake Business"}

    @classmethod
    def reset(cls) -> None:
        cls.sent = []
        cls.fail_next_send = False
        cls.crash_next_send = False
