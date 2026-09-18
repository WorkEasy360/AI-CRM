"""Provider registry. Adding a connector = one module implementing ``IntegrationProvider`` + one line here."""

from __future__ import annotations

from apps.integrations.providers.base import IntegrationProvider, ProviderError
from apps.integrations.providers.generic_rest import GenericRestProvider
from apps.integrations.providers.messaging import GoogleWorkspaceProvider, Microsoft365Provider, WhatsAppProvider

_REGISTRY: dict[str, IntegrationProvider] = {
    p.key: p for p in (GoogleWorkspaceProvider(), Microsoft365Provider(), WhatsAppProvider(), GenericRestProvider())
}


def all_providers() -> list[IntegrationProvider]:
    return list(_REGISTRY.values())


def get_provider(key: str) -> IntegrationProvider:
    try:
        return _REGISTRY[key]
    except KeyError as exc:
        raise ProviderError("unknown_provider") from exc


def hub_managed(key: str) -> bool:
    provider = _REGISTRY.get(key)
    return provider is not None and provider.managed_elsewhere is None


def register(provider: IntegrationProvider) -> None:
    """For future connectors (and tests): later registrations with the same key replace earlier ones."""
    _REGISTRY[provider.key] = provider
