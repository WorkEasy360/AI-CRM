from __future__ import annotations

from django.conf import settings

from apps.rag.embeddings.base import EmbeddingError, EmbeddingProvider, normalise

__all__ = ["EmbeddingError", "EmbeddingProvider", "current_model", "get_embedder", "normalise"]


def get_embedder() -> EmbeddingProvider:
    """The configured embedding backend. ``local`` is the default: no credentials, no cost, no network."""
    backend = getattr(settings, "RAG_EMBEDDING_BACKEND", "local")
    if backend == "voyage":
        from apps.rag.embeddings.remote import VoyageEmbedding

        return VoyageEmbedding()
    if backend == "openai":
        from apps.rag.embeddings.remote import OpenAIEmbedding

        return OpenAIEmbedding()
    from apps.rag.embeddings.local import LocalHashEmbedding

    return LocalHashEmbedding()


def current_model() -> str:
    """Model identifier stored on every chunk and required to match at retrieval time.

    Resolved without constructing the provider so it stays cheap and works even when a remote
    provider's credentials are missing (retrieval then simply finds no vectors for that model).
    """
    backend = getattr(settings, "RAG_EMBEDDING_BACKEND", "local")
    if backend == "local":
        from apps.rag.embeddings.local import MODEL_NAME

        return MODEL_NAME
    configured = getattr(settings, "RAG_EMBEDDING_MODEL", "")
    if configured:
        return configured
    return "voyage-3.5-lite" if backend == "voyage" else "text-embedding-3-small"
