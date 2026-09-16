"""Deterministic local embeddings: no network, no credentials, no cost.

This is the default so the assistant works on a fresh checkout, in CI and in any deployment that has
not bought an embedding provider. It hashes character n-grams and words into a fixed vector with
sublinear term weighting, which makes cosine similarity a *lexical* similarity measure: it finds
"pricing concern" from "worried about the price", but not from "the cost is too high".

That is a real limitation and the product tells the truth about it -- with this backend the
assistant is a very good search over customer conversations rather than a semantic one. Configure
``RAG_EMBEDDING_BACKEND=voyage`` (or ``openai``) to get semantic recall.

Properties that matter here: identical text always produces an identical vector (so ``content_hash``
skipping is meaningful), and nothing leaves the process.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import re
import unicodedata

from apps.rag.embeddings.base import normalise
from apps.rag.models import EMBEDDING_DIM

MODEL_NAME = "keel-local-hash-v1"
NGRAM = 4
_TOKEN = re.compile(r"[^\w]+", re.UNICODE)
# Words that carry no retrieval signal; keeping them just crowds the buckets.
_STOP_WORDS = """
    a an and are as at be been but by for from had has have he her his i if in into is it its me my not of on
    or our she so than that the their them then there these they this to was we were what when which who will
    with would you your
"""
# split() rather than a literal list: the data is a word list, and it should look like one.
_STOP = frozenset(_STOP_WORDS.split())


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def _bucket(token: str, salt: str) -> int:
    digest = hashlib.blake2b(f"{salt}\x1f{token}".encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") % EMBEDDING_DIM


def _sign(token: str) -> float:
    """Signed hashing: collisions cancel out on average instead of always adding up."""
    return 1.0 if hashlib.blake2b(token.encode(), digest_size=1).digest()[0] & 1 else -1.0


class LocalHashEmbedding:
    name = "local"
    model = MODEL_NAME
    dimensions = EMBEDDING_DIM
    usd_per_mtok = 0.0

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        counts: dict[tuple[str, str], int] = {}
        folded = _fold(text)
        words = [w for w in _TOKEN.split(folded) if w and w not in _STOP]
        for word in words:
            counts[("w", word)] = counts.get(("w", word), 0) + 1
            # Character n-grams give partial credit for inflections and typos ("pricing"/"prices").
            if len(word) > NGRAM:
                for i in range(len(word) - NGRAM + 1):
                    gram = word[i : i + NGRAM]
                    counts[("g", gram)] = counts.get(("g", gram), 0) + 1
        for first, second in itertools.pairwise(words):
            bigram = f"{first}_{second}"
            counts[("b", bigram)] = counts.get(("b", bigram), 0) + 1

        vector = [0.0] * EMBEDDING_DIM
        for (salt, token), count in counts.items():
            # Sublinear term frequency: the tenth mention of a word must not dominate the vector.
            weight = (1.0 + math.log(count)) * (0.5 if salt == "g" else 1.0)
            vector[_bucket(token, salt)] += weight * _sign(token)
        return normalise(vector)
