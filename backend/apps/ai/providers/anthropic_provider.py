"""Anthropic Claude adapter (official ``anthropic`` SDK).

- One non-streaming ``messages.create`` per feature call; outputs here are short (drafts, summaries).
- The static system prompt carries ``cache_control`` so repeated calls reuse the cached prefix.
- Adaptive thinking is left on for the strong model (Claude Opus 5) with a low/medium effort setting
  that the feature chooses; the fast model (Claude Haiku 4.5) runs without thinking.
- A ``refusal`` stop reason surfaces as ``LLMError(refused=True)`` and never as text.
"""

from __future__ import annotations

from typing import Any

import anthropic
from django.conf import settings

from apps.ai.providers.base import LLMError, LLMRequest, LLMResponse

EFFORT_MODELS = ("claude-opus-", "claude-sonnet-5", "claude-fable-")


def _supports_effort(model: str) -> bool:
    return model.startswith(EFFORT_MODELS)


class AnthropicProvider:
    name = "anthropic"

    def __init__(self) -> None:
        if not settings.ANTHROPIC_API_KEY:
            raise LLMError("AI is not configured for this deployment (missing ANTHROPIC_API_KEY).", status=503)
        self._client = anthropic.Anthropic(
            api_key=settings.ANTHROPIC_API_KEY,
            timeout=settings.AI_REQUEST_TIMEOUT_SECONDS,
            max_retries=1,
        )

    def complete(self, request: LLMRequest) -> LLMResponse:
        system: Any = request.system
        if request.cache_system:
            system = [{"type": "text", "text": request.system, "cache_control": {"type": "ephemeral"}}]
        kwargs: dict[str, Any] = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": request.user}],
            "metadata": {"user_id": request.metadata.get("user_id", "")[:64]}
            if request.metadata.get("user_id")
            else anthropic.NOT_GIVEN,
        }
        if _supports_effort(request.model):
            kwargs["thinking"] = {"type": "adaptive"}
            kwargs["output_config"] = {"effort": request.effort or "low"}
        elif request.temperature is not None:
            kwargs["temperature"] = request.temperature
        try:
            response = self._client.messages.create(**kwargs)
        except anthropic.RateLimitError as exc:
            raise LLMError("The AI service is busy. Try again in a moment.", retryable=True, status=429) from exc
        except anthropic.AuthenticationError as exc:
            raise LLMError("The AI service rejected the configured credentials.", status=503) from exc
        except anthropic.BadRequestError as exc:
            raise LLMError(f"The AI request was rejected: {exc.message}"[:255], status=400) from exc
        except anthropic.APIStatusError as exc:
            raise LLMError(
                "The AI service returned an error.", retryable=exc.status_code >= 500, status=exc.status_code
            ) from exc
        except anthropic.APIConnectionError as exc:
            raise LLMError("Could not reach the AI service.", retryable=True, status=503) from exc
        if response.stop_reason == "refusal":
            raise LLMError("The AI declined to answer this request.", refused=True)
        text = "".join(block.text for block in response.content if getattr(block, "type", "") == "text")
        usage = response.usage
        return LLMResponse(
            text=text,
            model=response.model,
            input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
            cache_read_tokens=int(getattr(usage, "cache_read_input_tokens", 0) or 0),
            cache_write_tokens=int(getattr(usage, "cache_creation_input_tokens", 0) or 0),
            stop_reason=response.stop_reason or "end_turn",
            request_id=getattr(response, "_request_id", "") or "",
        )
