"""Provider registry. ``MESSAGING_PROVIDER_BACKEND`` chooses live adapters or the fakes (tests, dev)."""

from __future__ import annotations

from django.conf import settings

from apps.messaging.providers.base import EmailProviderAdapter, ProviderError, WhatsAppProviderAdapter


def email_provider(name: str) -> EmailProviderAdapter:
    if getattr(settings, "MESSAGING_PROVIDER_BACKEND", "live") == "fake":
        from apps.messaging.providers.fake import FakeEmailProvider

        return FakeEmailProvider(name)
    if name == "gmail":
        from apps.messaging.providers.gmail import GmailProvider

        return GmailProvider()
    if name == "microsoft":
        from apps.messaging.providers.microsoft import MicrosoftProvider

        return MicrosoftProvider()
    raise ProviderError("Unknown email provider.")


def whatsapp_provider() -> WhatsAppProviderAdapter:
    if getattr(settings, "MESSAGING_PROVIDER_BACKEND", "live") == "fake":
        from apps.messaging.providers.fake import FakeWhatsAppProvider

        return FakeWhatsAppProvider()
    from apps.messaging.providers.whatsapp import WhatsAppCloudProvider

    return WhatsAppCloudProvider()


def email_provider_configured(name: str) -> bool:
    if getattr(settings, "MESSAGING_PROVIDER_BACKEND", "live") == "fake":
        return True
    if name == "gmail":
        return bool(settings.EMAIL_OAUTH_GOOGLE_CLIENT_ID and settings.EMAIL_OAUTH_GOOGLE_CLIENT_SECRET)
    if name == "microsoft":
        return bool(settings.EMAIL_OAUTH_MICROSOFT_CLIENT_ID and settings.EMAIL_OAUTH_MICROSOFT_CLIENT_SECRET)
    return False
