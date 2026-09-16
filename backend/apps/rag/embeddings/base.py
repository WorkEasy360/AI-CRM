"""Embedding provider protocol. The index stores vectors; it never learns which vendor made them.

Every adapter returns unit-length vectors of exactly ``EMBEDDING_DIM`` components, so one column and
one HNSW index serve every provider and cosine distance is comparable within a model. Vectors from
different models are *not* comparable, which is why every chunk records ``embedding_model`` and
retrieval only ever reads chunks embedded by the model currently configured.
"""

from __future__ import annotations

import math
from typing import Protocol

from apps.rag.models import EMBEDDING_DIM


class EmbeddingError(Exception):
    """An embedding call failed. ``retryable`` marks transient failures worth another attempt."""

    def __init__(self, message: str, *, retryable: bool = False, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.retryable = retryable
        self.status = status


class EmbeddingProvider(Protocol):
    name: str
    model: str
    dimensions: int
    # Rough per-million-token cost used by the usage ledger.
    usd_per_mtok: float

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def normalise(vector: list[float], *, dimensions: int = EMBEDDING_DIM) -> list[float]:
    """Pad or truncate to the column width, then scale to unit length.

    Unit length makes cosine distance equal to ``1 - dot``, which keeps the fusion weights in
    ``apps.rag.retrieval`` meaningful across providers.
    """
    if len(vector) < dimensions:
        vector = [*vector, *([0.0] * (dimensions - len(vector)))]
    elif len(vector) > dimensions:
        vector = vector[:dimensions]
    norm = math.sqrt(sum(component * component for component in vector))
    if norm == 0.0:
        return vector
    return [component / norm for component in vector]
