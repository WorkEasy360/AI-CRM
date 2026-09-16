"""HTTP embedding adapters: Voyage AI and OpenAI.

Both are plain JSON endpoints, so one small client covers them; neither SDK is added as a
dependency. Anthropic publishes no embeddings API, which is why the assistant's *reasoning* provider
and its *embedding* provider are configured separately -- Claude answers the question, a dedicated
embedding model builds the index.

Failures raise ``EmbeddingError``. Indexing is a background job, so a transient failure simply leaves
the source ``pending`` with a backoff; CRM data is never affected.
"""

from __future__ import annotations

from typing import Any

import httpx
from django.conf import settings

from apps.rag.embeddings.base import EmbeddingError, normalise
from apps.rag.models import EMBEDDING_DIM

VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
OPENAI_URL = "https://api.openai.com/v1/embeddings"
MAX_BATCH = 96


class _HttpEmbedding:
    name = ""
    url = ""
    dimensions = EMBEDDING_DIM

    def __init__(self, *, model: str, api_key: str, usd_per_mtok: float) -> None:
        if not api_key:
            raise EmbeddingError(f"{self.name} embeddings are not configured (missing API key).", status=503)
        self.model = model
        self.usd_per_mtok = usd_per_mtok
        self._api_key = api_key

    def _payload(self, texts: list[str]) -> dict[str, Any]:  # pragma: no cover - overridden
        raise NotImplementedError

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), MAX_BATCH):
            vectors.extend(self._embed_batch(texts[start : start + MAX_BATCH]))
        return vectors

    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        try:
            response = httpx.post(
                self.url,
                json=self._payload(texts),
                headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
                timeout=settings.RAG_EMBEDDING_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as exc:
            raise EmbeddingError("Could not reach the embedding service.", retryable=True, status=503) from exc
        if response.status_code == 429:
            raise EmbeddingError("The embedding service is rate limiting.", retryable=True, status=429)
        if response.status_code >= 500:
            raise EmbeddingError(
                "The embedding service returned an error.", retryable=True, status=response.status_code
            )
        if response.status_code >= 400:
            raise EmbeddingError(
                f"The embedding request was rejected ({response.status_code}).", status=response.status_code
            )
        try:
            rows = response.json()["data"]
            # Providers may return the batch out of order; `index` is authoritative.
            ordered = sorted(rows, key=lambda row: row.get("index", 0))
            return [normalise([float(x) for x in row["embedding"]]) for row in ordered]
        except (KeyError, TypeError, ValueError) as exc:
            raise EmbeddingError("The embedding service returned an unexpected response.", retryable=True) from exc


class VoyageEmbedding(_HttpEmbedding):
    name = "voyage"
    url = VOYAGE_URL

    def __init__(self) -> None:
        super().__init__(
            model=settings.RAG_EMBEDDING_MODEL or "voyage-3.5-lite",
            api_key=settings.VOYAGE_API_KEY,
            usd_per_mtok=settings.RAG_EMBEDDING_USD_PER_MTOK,
        )

    def _payload(self, texts: list[str]) -> dict[str, Any]:
        return {
            "model": self.model,
            "input": texts,
            "input_type": "document",
            "output_dimension": EMBEDDING_DIM,
        }


class OpenAIEmbedding(_HttpEmbedding):
    name = "openai"
    url = OPENAI_URL

    def __init__(self) -> None:
        super().__init__(
            model=settings.RAG_EMBEDDING_MODEL or "text-embedding-3-small",
            api_key=settings.OPENAI_API_KEY,
            usd_per_mtok=settings.RAG_EMBEDDING_USD_PER_MTOK,
        )

    def _payload(self, texts: list[str]) -> dict[str, Any]:
        return {"model": self.model, "input": texts, "dimensions": EMBEDDING_DIM}
