"""WhatsApp Cloud API webhook (public, unauthenticated by design; authenticated by HMAC signature).

Reviewed public endpoint (see tests/authz_matrix/test_route_coverage.py ALLOWED_PUBLIC). The
verification handshake compares the configured verify token; every POST must carry a valid
``X-Hub-Signature-256`` computed with the app secret, or it is discarded. The account is located by
``phone_number_id`` under a system context and the payload is processed inside that tenant only.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
from typing import Any

import structlog
from django.conf import settings
from django.http import HttpResponse
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.tenancy.context import system_context, tenant_context
from apps.messaging import services
from apps.messaging.models import ConnectionStatus, WhatsAppAccount

log = structlog.get_logger(__name__)
MAX_BODY_BYTES = 512 * 1024


def signature_valid(raw_body: bytes, header: str | None) -> bool:
    secret = settings.WHATSAPP_APP_SECRET
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256=") :])


class WhatsAppWebhookView(APIView):
    permission_classes = [AllowAny]
    authentication_classes: list = []  # no session, no CSRF: signature-authenticated machine endpoint
    throttle_scope = "search"

    def get(self, request):
        params = request.query_params
        if (
            params.get("hub.mode") == "subscribe"
            and settings.WHATSAPP_VERIFY_TOKEN
            and hmac.compare_digest(params.get("hub.verify_token", ""), settings.WHATSAPP_VERIFY_TOKEN)
        ):
            return HttpResponse(params.get("hub.challenge", "")[:128], content_type="text/plain")
        return Response(status=403)

    def post(self, request):
        raw = request.body
        if len(raw) > MAX_BODY_BYTES:
            return Response(status=413)
        if not signature_valid(raw, request.META.get("HTTP_X_HUB_SIGNATURE_256")):
            log.warning("whatsapp.webhook_bad_signature")
            return Response(status=403)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return Response(status=400)
        handled = process_payload(payload)
        return Response({"handled": handled})


def process_payload(payload: dict[str, Any]) -> int:
    handled = 0
    for entry in (payload.get("entry") or [])[:50]:
        for change in (entry.get("changes") or [])[:50]:
            value = change.get("value") or {}
            phone_number_id = str((value.get("metadata") or {}).get("phone_number_id") or "")[:64]
            if not phone_number_id:
                continue
            with system_context("whatsapp.webhook.locate_account"):
                account_row = (
                    WhatsAppAccount.all_objects.filter(
                        phone_number_id=phone_number_id, status=ConnectionStatus.CONNECTED
                    )
                    .values_list("organization_id", "id")
                    .first()
                )
            if account_row is None:
                continue
            org_id, account_id = account_row
            with tenant_context(org_id, reason="whatsapp.webhook"):
                account = WhatsAppAccount.objects.filter(pk=account_id).first()
                if account is None:
                    continue
                for message in (value.get("messages") or [])[:100]:
                    if message.get("type") != "text":
                        continue
                    ts = message.get("timestamp")
                    try:
                        received = dt.datetime.fromtimestamp(int(ts), tz=dt.UTC)
                    except (TypeError, ValueError):
                        received = dt.datetime.now(tz=dt.UTC)
                    if services.record_inbound_whatsapp(
                        account,
                        wa_id=str(message.get("from") or ""),
                        provider_message_id=str(message.get("id") or ""),
                        body=str((message.get("text") or {}).get("body") or ""),
                        received_at=received,
                    ):
                        handled += 1
                for status in (value.get("statuses") or [])[:100]:
                    services.apply_whatsapp_status(str(status.get("id") or ""), str(status.get("status") or ""))
                    handled += 1
    return handled
