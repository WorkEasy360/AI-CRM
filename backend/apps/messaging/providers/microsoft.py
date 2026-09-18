"""Microsoft 365 via Microsoft identity platform OAuth 2.0 (PKCE) and Microsoft Graph."""

from __future__ import annotations

import base64
import datetime as dt
import re
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

GRAPH = "https://graph.microsoft.com/v1.0"
SCOPES = ["offline_access", "openid", "email", "profile", "User.Read", "Mail.Send", "Mail.Read"]
TIMEOUT = httpx.Timeout(20.0, connect=5.0)
_TAGS = re.compile(r"<[^>]+>")


def _raise(resp: httpx.Response, what: str) -> None:
    if resp.status_code < 400:
        return
    retryable = resp.status_code in {429, 500, 502, 503, 504}
    raise ProviderError(
        f"Microsoft 365 {what} failed ({resp.status_code}).", retryable=retryable, status=resp.status_code
    )


class MicrosoftProvider:
    provider = "microsoft"

    def __init__(self) -> None:
        self.client_id = settings.EMAIL_OAUTH_MICROSOFT_CLIENT_ID
        self.client_secret = settings.EMAIL_OAUTH_MICROSOFT_CLIENT_SECRET
        self.tenant = settings.EMAIL_OAUTH_MICROSOFT_TENANT or "common"
        if not self.client_id or not self.client_secret:
            raise ProviderError(
                "Microsoft 365 is not configured. Ask an administrator to set the Microsoft OAuth credentials."
            )

    @property
    def _auth_base(self) -> str:
        return f"https://login.microsoftonline.com/{self.tenant}/oauth2/v2.0"

    def authorization_url(self, *, state: str, redirect_uri: str, code_challenge: str) -> str:
        params = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "response_mode": "query",
            "scope": " ".join(SCOPES),
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{self._auth_base}/authorize?{urlencode(params)}"

    def _tokens(self, data: dict[str, Any]) -> OAuthTokens:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.post(
                f"{self._auth_base}/token",
                data={
                    **data,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "scope": " ".join(SCOPES),
                },
            )
            _raise(resp, "token request")
            payload = resp.json()
            access = payload["access_token"]
            me = client.get(f"{GRAPH}/me", headers={"Authorization": f"Bearer {access}"})
            _raise(me, "profile lookup")
            profile = me.json()
        return OAuthTokens(
            access_token=access,
            refresh_token=payload.get("refresh_token", data.get("refresh_token", "")),
            expires_at=timezone.now() + dt.timedelta(seconds=int(payload.get("expires_in", 3600))),
            email_address=(profile.get("mail") or profile.get("userPrincipalName") or "").lower(),
            display_name=profile.get("displayName", ""),
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
        def recipients(addresses: list[str]) -> list[dict[str, Any]]:
            return [{"emailAddress": {"address": a}} for a in addresses]

        body: dict[str, Any] = {
            "message": {
                "subject": message.subject,
                "body": {"contentType": "Text", "content": message.body_text},
                "toRecipients": recipients(message.to),
                "ccRecipients": recipients(message.cc),
                "bccRecipients": recipients(message.bcc),
                "attachments": [
                    {
                        "@odata.type": "#microsoft.graph.fileAttachment",
                        "name": filename,
                        "contentType": content_type,
                        "contentBytes": base64.b64encode(data).decode("ascii"),
                    }
                    for filename, content_type, data in message.attachments
                ],
            },
            "saveToSentItems": True,
        }
        if message.idempotency_key:
            # Graph accepts internetMessageId on the outgoing message and can $filter on it later.
            body["message"]["internetMessageId"] = rfc822_message_id(message.idempotency_key)
        headers = {"Authorization": f"Bearer {access_token}"}
        with httpx.Client(timeout=TIMEOUT) as client:
            if message.in_reply_to:
                # Reply keeps the Graph conversation; create a reply draft from the original message id.
                reply = client.post(f"{GRAPH}/me/messages/{message.in_reply_to}/createReply", headers=headers)
                if reply.status_code < 400:
                    draft = reply.json()
                    patch = client.patch(
                        f"{GRAPH}/me/messages/{draft['id']}",
                        json={
                            "body": {"contentType": "Text", "content": message.body_text},
                            "toRecipients": recipients(message.to),
                        },
                        headers=headers,
                    )
                    _raise(patch, "reply")
                    sent = client.post(f"{GRAPH}/me/messages/{draft['id']}/send", headers=headers)
                    _raise(sent, "send")
                    return SentEmail(
                        provider_message_id=draft["id"], provider_thread_id=draft.get("conversationId", "")
                    )
            resp = client.post(f"{GRAPH}/me/sendMail", json=body, headers=headers)
            _raise(resp, "send")
        # sendMail returns 202 with no body; the sent item is located by subject/time during sync.
        return SentEmail(provider_message_id="", provider_thread_id=message.thread_id)

    def find_sent(self, access_token: str, idempotency_key: str) -> SentEmail | None:
        """Look the send up in Sent Items by the internetMessageId stamped on it."""
        if not idempotency_key:
            return None
        message_id = rfc822_message_id(idempotency_key).replace("'", "''")
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.get(
                f"{GRAPH}/me/messages",
                params={"$filter": f"internetMessageId eq '{message_id}'", "$top": 1, "$select": "id,conversationId"},
                headers={"Authorization": f"Bearer {access_token}"},
            )
            _raise(resp, "lookup")
            found = resp.json().get("value") or []
        if not found:
            return None
        return SentEmail(
            provider_message_id=found[0].get("id", ""), provider_thread_id=found[0].get("conversationId", "")
        )

    def fetch_recent(self, access_token: str, *, since: dt.datetime, cursor: str) -> tuple[list[IncomingEmail], str]:
        headers = {"Authorization": f"Bearer {access_token}"}
        params = {
            "$filter": f"receivedDateTime ge {since.astimezone(dt.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')}",
            "$orderby": "receivedDateTime desc",
            "$top": "50",
            "$select": (
                "id,conversationId,from,toRecipients,subject,bodyPreview,body,receivedDateTime,internetMessageId"
            ),
        }
        out: list[IncomingEmail] = []
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.get(f"{GRAPH}/me/mailFolders/inbox/messages", params=params, headers=headers)
            _raise(resp, "list")
            for item in resp.json().get("value", []):
                from_address = ((item.get("from") or {}).get("emailAddress") or {}).get("address", "")
                if not from_address:
                    continue
                content = (item.get("body") or {}).get("content", "")
                if (item.get("body") or {}).get("contentType", "").lower() == "html":
                    content = _TAGS.sub(" ", content)
                received = dt.datetime.fromisoformat(item["receivedDateTime"].replace("Z", "+00:00"))
                out.append(
                    IncomingEmail(
                        provider_message_id=item.get("id", ""),
                        provider_thread_id=item.get("conversationId", ""),
                        from_address=from_address.lower(),
                        to=[
                            ((r.get("emailAddress") or {}).get("address") or "").lower()
                            for r in item.get("toRecipients", [])
                        ],
                        subject=(item.get("subject") or "")[:255],
                        body_text=" ".join(content.split())[:20000] or item.get("bodyPreview", ""),
                        received_at=received,
                    )
                )
        return out, cursor
