"""Provider routing: primary model, cheaper fallback model, then nothing.

    Level 1   the configured strong/fast model      -> best answer
    Level 2   AI_FALLBACK_MODEL, if configured      -> cheaper, still a real answer
    Level 3   raise, and the caller answers from CRM + RAG instead

Level 3 is not an error path. It is a supported product mode: ``apps.assistant`` catches
``AllProvidersUnavailableError`` and renders a deterministic answer from the CRM. The user sees the same
interface either way.

**When we fall back.** Only on conditions that mean "the provider could not serve this request":
timeouts, connection failures, 5xx, 429, quota exhaustion, and an explicitly disabled provider. A
refusal is *not* a failure -- the model considered the request and declined, and retrying it on a
cheaper model is both wasteful and a way to launder a refusal. Neither is a 400: that is our bug and
a second model will reject it too.

**Circuit breaker.** When a provider fails repeatedly, every subsequent user waits out the same
timeout before getting the same fallback. After ``AI_BREAKER_FAILURES`` consecutive failures the
router stops calling that model for ``AI_BREAKER_COOLDOWN_SECONDS`` and goes straight to the next
level, so an outage costs one slow request rather than one per user. The breaker lives in Redis and
fails open: if the cache is down, calls are attempted normally.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass, replace

import structlog
from django.conf import settings
from django.core.cache import cache

from apps.ai.providers import get_provider
from apps.ai.providers.base import LLMError, LLMRequest, LLMResponse

log = structlog.get_logger(__name__)

LEVEL_PRIMARY = "primary"
LEVEL_FALLBACK = "fallback"
BREAKER_TTL = 3600


class AllProvidersUnavailableError(Exception):
    """Every configured level failed. The caller must answer without a model."""

    def __init__(self, message: str, *, last_error: LLMError | None = None):
        super().__init__(message)
        self.message = message
        self.last_error = last_error


@dataclass
class RoutedResponse:
    response: LLMResponse
    level: str
    model: str
    degraded: bool = False


def is_transient(error: LLMError) -> bool:
    """True when another model might succeed where this one did not."""
    if error.refused:
        return False
    status = error.status or 0
    return bool(error.retryable) or status in {408, 409, 425, 429} or status >= 500


def complete(request: LLMRequest) -> RoutedResponse:
    """Try each configured level in turn. Raises ``AllProvidersUnavailableError`` when none can answer."""
    levels: list[tuple[str, str]] = [(LEVEL_PRIMARY, request.model)]
    fallback_model = getattr(settings, "AI_FALLBACK_MODEL", "") or ""
    if fallback_model and fallback_model != request.model:
        levels.append((LEVEL_FALLBACK, fallback_model))

    last_error: LLMError | None = None
    for level, model in levels:
        if _breaker_open(model):
            log.info("ai.router.breaker_open", level=level, feature=request.feature)
            continue
        try:
            response = get_provider().complete(replace(request, model=model))
        except LLMError as exc:
            last_error = exc
            if not is_transient(exc):
                # A refusal or a malformed request: no other model will do better.
                raise
            _record_failure(model)
            log.warning("ai.router.level_failed", level=level, status=exc.status, feature=request.feature)
            continue
        _record_success(model)
        return RoutedResponse(response=response, level=level, model=response.model, degraded=level != LEVEL_PRIMARY)

    raise AllProvidersUnavailableError(
        (last_error.message if last_error else "No AI provider is available."), last_error=last_error
    )


def _breaker_key(model: str) -> str:
    return f"ai:breaker:{model}"


def _breaker_open(model: str) -> bool:
    if settings.AI_BREAKER_FAILURES <= 0:
        return False
    try:
        state = cache.get(_breaker_key(model))
    except Exception:  # pragma: no cover - cache down: attempt the call
        return False
    return bool(state and state.get("open_until", 0) > _now())


def _record_failure(model: str) -> None:
    if settings.AI_BREAKER_FAILURES <= 0:
        return
    with contextlib.suppress(Exception):  # cache down: the breaker simply does not engage
        state = cache.get(_breaker_key(model)) or {"failures": 0, "open_until": 0}
        state["failures"] = int(state.get("failures", 0)) + 1
        if state["failures"] >= settings.AI_BREAKER_FAILURES:
            state["open_until"] = _now() + settings.AI_BREAKER_COOLDOWN_SECONDS
            state["failures"] = 0
            log.warning("ai.router.breaker_tripped", model=model)
        cache.set(_breaker_key(model), state, BREAKER_TTL)


def _record_success(model: str) -> None:
    with contextlib.suppress(Exception):
        cache.delete(_breaker_key(model))


def _now() -> float:
    import time

    return time.time()
