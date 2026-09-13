"""LLM provider protocol. Business code only sees ``LLMRequest`` / ``LLMResponse``; vendors live behind it."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


class LLMError(Exception):
    """A provider call failed. ``retryable`` marks transient failures; ``refused`` marks safety refusals."""

    def __init__(self, message: str, *, retryable: bool = False, refused: bool = False, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.retryable = retryable
        self.refused = refused
        self.status = status


@dataclass
class LLMRequest:
    system: str
    user: str
    model: str
    max_tokens: int
    feature: str
    temperature: float | None = None
    effort: str | None = None  # low | medium | high (models that support it)
    cache_system: bool = True
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass
class LLMResponse:
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    stop_reason: str = "end_turn"
    request_id: str = ""


class LLMProvider(Protocol):
    name: str

    def complete(self, request: LLMRequest) -> LLMResponse: ...
