from __future__ import annotations

from django.conf import settings

from apps.ai.providers.base import LLMError, LLMProvider, LLMRequest, LLMResponse

__all__ = ["LLMError", "LLMProvider", "LLMRequest", "LLMResponse", "get_provider"]


def get_provider() -> LLMProvider:
    backend = getattr(settings, "AI_PROVIDER_BACKEND", "anthropic")
    if backend == "fake":
        from apps.ai.providers.fake import FakeProvider

        return FakeProvider()
    from apps.ai.providers.anthropic_provider import AnthropicProvider

    return AnthropicProvider()
