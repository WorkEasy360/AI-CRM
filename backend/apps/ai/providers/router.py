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

**Deadline.** These calls run on a web request thread, inside the request's database transaction. The
whole chain (every level, no SDK retries) must finish within ``AI_INTERACTIVE_DEADLINE_SECONDS``: two
levels of 45 s plus an SDK retry each could otherwise hold a thread for minutes, past the 60 s load
balancer and CloudFront timeouts and past Postgres' 60 s ``idle_in_transaction_session_timeout`` (which
kills the connection and turns a paid-for answer into a 500). A level is not started with less than
``AI_MIN_ATTEMPT_SECONDS`` left.

**Bulkhead.** At most ``AI_MAX_CONCURRENT_CALLS_PER_PROCESS`` provider calls wait at once per process.
When a slow provider fills those slots the next caller degrades immediately (the assistant answers from
the CRM, drafting features answer 503) instead of taking a thread that contacts, deals and the pipeline
need, so a provider slowdown cannot exhaust the API's request threads.
"""

from __future__ import annotations

import contextlib
import threading
import time
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

    slots = _call_slots()
    if slots is not None and not slots.acquire(blocking=False):
        log.warning("ai.router.saturated", feature=request.feature)
        raise AllProvidersUnavailableError("The AI service is busy. Try again in a moment.")
    try:
        return _complete_levels(request, levels)
    finally:
        if slots is not None:
            slots.release()


def _complete_levels(request: LLMRequest, levels: list[tuple[str, str]]) -> RoutedResponse:
    deadline = time.monotonic() + settings.AI_INTERACTIVE_DEADLINE_SECONDS
    last_error: LLMError | None = None
    for level, model in levels:
        if _breaker_open(model):
            log.info("ai.router.breaker_open", level=level, feature=request.feature)
            continue
        remaining = deadline - time.monotonic()
        if remaining < settings.AI_MIN_ATTEMPT_SECONDS:
            log.warning("ai.router.deadline_exhausted", level=level, feature=request.feature)
            break
        timeout = min(settings.AI_REQUEST_TIMEOUT_SECONDS, remaining)
        try:
            response = get_provider().complete(replace(request, model=model, timeout=timeout))
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


_slots_lock = threading.Lock()
_slots: tuple[int, threading.BoundedSemaphore] | None = None


def _call_slots() -> threading.BoundedSemaphore | None:
    """The per-process bulkhead (``AI_MAX_CONCURRENT_CALLS_PER_PROCESS``; 0 disables it)."""
    global _slots
    limit = settings.AI_MAX_CONCURRENT_CALLS_PER_PROCESS
    if limit <= 0:
        return None
    with _slots_lock:
        if _slots is None or _slots[0] != limit:
            _slots = (limit, threading.BoundedSemaphore(limit))
        return _slots[1]


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
    return time.time()
