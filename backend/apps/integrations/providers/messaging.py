"""Hub adapters over the existing messaging integrations (Google Workspace, Microsoft 365, WhatsApp).

These connections already have their own secure flows and tables in ``apps.messaging`` (OAuth with
PKCE and encrypted tokens for mailboxes, an encrypted Cloud API token and a signed webhook for
WhatsApp). The hub does not copy their credentials: it summarizes status, runs a health check and
links to the existing settings page.
"""

from __future__ import annotations

from typing import Any

from apps.authz.actor import Actor
from apps.integrations.providers.base import IntegrationProvider


def _mailbox_summary(actor: Actor, provider: str) -> dict[str, Any]:
    from apps.messaging import providers as messaging_providers
    from apps.messaging.models import ConnectionStatus, EmailAccount

    live = EmailAccount.objects.filter(
        provider=provider, status__in=[ConnectionStatus.CONNECTED, ConnectionStatus.ERROR]
    )
    connected = live.filter(status=ConnectionStatus.CONNECTED).count()
    errors = live.filter(status=ConnectionStatus.ERROR).count()
    mine = live.filter(membership_id=actor.membership.pk).values_list("status", "email_address").first()
    if errors:
        status = "action_required"
    elif connected:
        status = "connected"
    else:
        status = "available"
    return {
        "status": status,
        "configured": messaging_providers.email_provider_configured(provider),
        "connected_count": connected,
        "error_count": errors,
        "mine": {"status": mine[0], "email_address": mine[1]} if mine else None,
    }


class GoogleWorkspaceProvider(IntegrationProvider):
    key = "google"
    name = "Google Workspace"
    description = "Send and receive Gmail from CRM records. Each member connects their own mailbox with Google sign-in."
    category = "email"
    auth_types = ("oauth2_code",)
    managed_elsewhere = "/settings/email"

    def summary(self, actor: Actor) -> dict[str, Any]:
        return _mailbox_summary(actor, "gmail")


class Microsoft365Provider(IntegrationProvider):
    key = "microsoft"
    name = "Microsoft 365"
    description = (
        "Send and receive Outlook email from CRM records. "
        "Each member connects their own mailbox with Microsoft sign-in."
    )
    category = "email"
    auth_types = ("oauth2_code",)
    managed_elsewhere = "/settings/email"

    def summary(self, actor: Actor) -> dict[str, Any]:
        return _mailbox_summary(actor, "microsoft")


class WhatsAppProvider(IntegrationProvider):
    key = "whatsapp"
    name = "WhatsApp Business"
    description = "Message customers through the official WhatsApp Cloud API, with signed delivery webhooks."
    category = "messaging"
    auth_types = ("api_key", "signed_webhook")
    managed_elsewhere = "/settings/whatsapp"

    def summary(self, actor: Actor) -> dict[str, Any]:
        from apps.messaging.models import ConnectionStatus, WhatsAppAccount

        account = WhatsAppAccount.objects.values("status", "display_phone").first()
        if account is None or account["status"] == ConnectionStatus.DISCONNECTED:
            status = "available"
        elif account["status"] == ConnectionStatus.ERROR:
            status = "action_required"
        else:
            status = "connected"
        return {
            "status": status,
            "configured": True,
            "connected_count": 1 if status != "available" else 0,
            "error_count": 1 if status == "action_required" else 0,
            "mine": None,
        }
