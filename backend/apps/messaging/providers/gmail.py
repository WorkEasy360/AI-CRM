"""Gmail via Google OAuth 2.0 (PKCE) and the Gmail REST API. Users never hand us a password."""

from __future__ import annotations

import base64
import datetime as dt
import email.utils
from email.message import EmailMessage as MimeMessage
from typing import Any
from urllib.parse import urlencode

import httpx
from django.conf import settings
from django.utils import timezone

from apps.messaging.providers.base import (
    IncomingEmail,
    OAuthTokens,
    OutgoingEmail,
    ProviderError,
    SendCapabilities,
    SentEmail,
    rfc822_message_id,
)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - URL, not a secret  # nosec B105 - not a secret
API = "https://gmail.googleapis.com/gmail/v1/users/me"
SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "openid",
    "email",
    "profile",
]
TIMEOUT = httpx.Timeout(20.0, connect=5.0)


def _raise(resp: httpx.Response, what: str) -> None:
    if resp.status_code < 400:
        return
    retryable = resp.status_code in {429, 500, 502, 503, 504}
    raise ProviderError(f"Gmail {what} failed ({resp.status_code}).", retryable=retryable, status=resp.status_code)


class GmailProvider:
    provider = "gmail"

    def __init__(self) -> None:
        self.client_id = settings.EMAIL_OAUTH_GOOGLE_CLIENT_ID
        self.client_secret = settings.EMAIL_OAUTH_GOOGLE_CLIENT_SECRET
        if not self.client_id or not self.client_secret:
            raise ProviderError("Gmail is not configured. Ask an administrator to set the Google OAuth credentials.")

    def authorization_url(self, *, state: str, redirect_uri: str, code_challenge: str) -> str:
        params = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{AUTH_URL}?{urlencode(params)}"

    def _tokens(self, data: dict[str, Any]) -> OAuthTokens:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.post(
                TOKEN_URL, data={**data, "client_id": self.client_id, "client_secret": self.client_secret}
            )
            _raise(resp, "token request")
            payload = resp.json()
            access = payload["access_token"]
            profile = client.get(f"{API}/profile", headers={"Authorization": f"Bearer {access}"})
            _raise(profile, "profile lookup")
            address = profile.json().get("emailAddress", "")
        return OAuthTokens(
            access_token=access,
            refresh_token=payload.get("refresh_token", data.get("refresh_token", "")),
            expires_at=timezone.now() + dt.timedelta(seconds=int(payload.get("expires_in", 3600))),
            email_address=address,
            scopes=payload.get("scope", "").split(),
        )

    def exchange_code(self, *, code: str, redirect_uri: str, code_verifier: str) -> OAuthTokens:
        return self._tokens(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            }
        )

    def refresh(self, refresh_token: str) -> OAuthTokens:
        return self._tokens({"grant_type": "refresh_token", "refresh_token": refresh_token})

    # Gmail/Graph do not de-duplicate a repeated send, but both preserve and index the
    # Message-ID we stamp on it, so a lost result can be reconciled instead of resent.
    capabilities = SendCapabilities(idempotent_send=False, lookup_by_key=True)

    def send(self, access_token: str, message: OutgoingEmail) -> SentEmail:
        mime = MimeMessage()
        mime["From"] = message.from_address
        mime["To"] = ", ".join(message.to)
        if message.cc:
            mime["Cc"] = ", ".join(message.cc)
        if message.bcc:
            mime["Bcc"] = ", ".join(message.bcc)
        mime["Subject"] = message.subject
        mime["Date"] = email.utils.formatdate(localtime=False)
        if message.idempotency_key:
            # Gmail preserves a supplied Message-ID and indexes it for rfc822msgid: search, which is
            # what ``find_sent`` uses to answer "did the send that crashed actually go out?".
            mime["Message-ID"] = rfc822_message_id(message.idempotency_key)
        if message.in_reply_to:
            mime["In-Reply-To"] = message.in_reply_to
            mime["References"] = message.in_reply_to
        mime.set_content(message.body_text)
        for filename, content_type, data in message.attachments:
            maintype, _, subtype = (content_type or "application/octet-stream").partition("/")
            mime.add_attachment(data, maintype=maintype, subtype=subtype or "octet-stream", filename=filename)
        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode("ascii")
        body: dict[str, Any] = {"raw": raw}
        if message.thread_id:
            body["threadId"] = message.thread_id
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.post(f"{API}/messages/send", json=body, headers={"Authorization": f"Bearer {access_token}"})
            _raise(resp, "send")
            payload = resp.json()
        return SentEmail(provider_message_id=payload.get("id", ""), provider_thread_id=payload.get("threadId", ""))

    def find_sent(self, access_token: str, idempotency_key: str) -> SentEmail | None:
        """Look the send up by the deterministic Message-ID stamped on it."""
        if not idempotency_key:
            return None
        query = f"rfc822msgid:{rfc822_message_id(idempotency_key).strip('<>')}"
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.get(
                f"{API}/messages",
                params={"q": query, "maxResults": 1},
                headers={"Authorization": f"Bearer {access_token}"},
            )
            _raise(resp, "lookup")
            found = resp.json().get("messages") or []
        if not found:
            return None
        return SentEmail(provider_message_id=found[0].get("id", ""), provider_thread_id=found[0].get("threadId", ""))

    def fetch_recent(self, access_token: str, *, since: dt.datetime, cursor: str) -> tuple[list[IncomingEmail], str]:
        headers = {"Authorization": f"Bearer {access_token}"}
        query = f"in:inbox after:{int(since.timestamp())}"
        out: list[IncomingEmail] = []
        with httpx.Client(timeout=TIMEOUT) as client:
            listing = client.get(f"{API}/messages", params={"q": query, "maxResults": 50}, headers=headers)
            _raise(listing, "list")
            for item in listing.json().get("messages", [])[:50]:
                detail = client.get(
                    f"{API}/messages/{item['id']}",
                    params={"format": "full"},
                    headers=headers,
                )
                if detail.status_code >= 400:
                    continue
                parsed = _parse_gmail_message(detail.json())
                if parsed is not None:
                    out.append(parsed)
        return out, cursor


def _header(headers: list[dict[str, str]], name: str) -> str:
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _body_text(payload: dict[str, Any]) -> str:
    if payload.get("mimeType", "").startswith("text/plain") and payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"] + "==").decode("utf-8", "ignore")
    for part in payload.get("parts", []) or []:
        text = _body_text(part)
        if text:
            return text
    return ""


def _parse_gmail_message(msg: dict[str, Any]) -> IncomingEmail | None:
    payload = msg.get("payload", {})
    headers = payload.get("headers", [])
    from_raw = _header(headers, "From")
    _, from_address = email.utils.parseaddr(from_raw)
    if not from_address:
        return None
    to_raw = _header(headers, "To")
    to = [addr for _, addr in email.utils.getaddresses([to_raw]) if addr]
    received = dt.datetime.fromtimestamp(int(msg.get("internalDate", "0")) / 1000, tz=dt.UTC)
    return IncomingEmail(
        provider_message_id=msg.get("id", ""),
        provider_thread_id=msg.get("threadId", ""),
        from_address=from_address.lower(),
        to=[t.lower() for t in to],
        subject=_header(headers, "Subject")[:255],
        body_text=_body_text(payload)[:20000] or msg.get("snippet", ""),
        received_at=received,
        in_reply_to=_header(headers, "In-Reply-To")[:255],
    )
