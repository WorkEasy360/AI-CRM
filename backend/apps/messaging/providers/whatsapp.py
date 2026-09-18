"""WhatsApp Business Platform - Cloud API (official). No browser automation, no unofficial clients."""

from __future__ import annotations

import contextlib
from typing import Any

import httpx
from django.conf import settings

from apps.messaging.providers.base import NO_IDEMPOTENCY, OutgoingWhatsApp, ProviderError

TIMEOUT = httpx.Timeout(20.0, connect=5.0)


def _base() -> str:
    return f"https://graph.facebook.com/{settings.WHATSAPP_API_VERSION}"


def _raise(resp: httpx.Response, what: str) -> None:
    if resp.status_code < 400:
        return
    detail = ""
    with contextlib.suppress(ValueError):
        detail = (resp.json().get("error") or {}).get("message", "")[:120]
    retryable = resp.status_code in {429, 500, 502, 503, 504}
    raise ProviderError(
        f"WhatsApp {what} failed ({resp.status_code}). {detail}".strip(), retryable=retryable, status=resp.status_code
    )


class WhatsAppCloudProvider:
    # The Cloud API has no idempotency key and no way to look a send up by one of ours. A send whose
    # result we lost therefore ends as UNCONFIRMED and is never replayed: a duplicate WhatsApp message
    # to a customer is worse than a status a human has to close out.
    capabilities = NO_IDEMPOTENCY

    def send(self, access_token: str, phone_number_id: str, message: OutgoingWhatsApp) -> str:
        payload: dict[str, Any] = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": message.to}
        if message.template_name:
            payload["type"] = "template"
            template: dict[str, Any] = {"name": message.template_name, "language": {"code": message.template_language}}
            if message.template_params:
                template["components"] = [
                    {"type": "body", "parameters": [{"type": "text", "text": p} for p in message.template_params]}
                ]
            payload["template"] = template
        else:
            payload["type"] = "text"
            payload["text"] = {"preview_url": False, "body": message.body}
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.post(
                f"{_base()}/{phone_number_id}/messages",
                json=payload,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            _raise(resp, "send")
            data = resp.json()
        messages = data.get("messages") or []
        return messages[0].get("id", "") if messages else ""

    def verify_account(self, access_token: str, phone_number_id: str) -> dict[str, Any]:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.get(
                f"{_base()}/{phone_number_id}",
                params={"fields": "display_phone_number,verified_name,quality_rating"},
                headers={"Authorization": f"Bearer {access_token}"},
            )
            _raise(resp, "account lookup")
            return resp.json()
