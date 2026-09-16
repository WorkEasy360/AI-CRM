"""Turn one source document into retrievable chunks.

Chunk shape follows the source, not a fixed window:

- **Email** -- subject plus paragraph groups. The subject is repeated into the first chunk so a
  search for the subject line finds the body that belongs to it.
- **WhatsApp** -- one chunk per message. Grouping consecutive messages would read better, but a
  group cannot be deleted or replaced by *exact source identity* when one of its messages changes,
  and that guarantee matters more than prose. Short messages therefore carry a dated header so they
  stay retrievable on their own.
- **Meetings and calls** -- the write-up as one compact chunk (two when it is genuinely long).
- **Notes and deal descriptions** -- one chunk, split on paragraph boundaries only when long.

Every chunk keeps a header line naming the source and its date, which both improves retrieval of
short texts and gives the model the provenance it needs to cite accurately.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from apps.rag.models import SourceType

TARGET_CHARS = 900
MAX_CHARS = 1400
MIN_CHARS = 120
MAX_CHUNKS_PER_SOURCE = 6
_PARAGRAPH = re.compile(r"\n\s*\n")
_WS = re.compile(r"[ \t]+")
# Quoted reply chains and signatures repeat the same text into every chunk of a thread.
_QUOTED_LINE = re.compile(r"^\s*(>|On .{0,80} wrote:|-{2,}\s*Original Message)", re.IGNORECASE)
_SIGNATURE = re.compile(r"^\s*--\s*$", re.MULTILINE)

MAX_CHUNKS = {
    SourceType.EMAIL: 4,
    SourceType.WHATSAPP: 1,
    SourceType.ACTIVITY: 2,
    SourceType.NOTE: 3,
    SourceType.DEAL: 2,
}


@dataclass(frozen=True)
class Chunk:
    index: int
    content: str


def _normalise(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    return _WS.sub(" ", text).strip()


def strip_email_noise(body: str) -> str:
    """Drop quoted reply chains and everything after the signature marker.

    Without this every reply in a thread re-embeds the whole thread beneath it: the same sentences
    come back several times in retrieval and the embedding bill multiplies with thread depth.
    """
    body = _SIGNATURE.split(body, maxsplit=1)[0]
    lines: list[str] = []
    for line in body.split("\n"):
        if _QUOTED_LINE.match(line):
            break
        lines.append(line)
    return "\n".join(lines)


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in _PARAGRAPH.split(text) if p.strip()]


def _pack(paragraphs: list[str], *, target: int, maximum: int) -> list[str]:
    """Greedily group paragraphs up to ``target``; split a single oversized paragraph on sentences."""
    out: list[str] = []
    buffer = ""
    for para in paragraphs:
        for piece in _split_long(para, maximum):
            if not buffer:
                buffer = piece
            elif len(buffer) + len(piece) + 2 <= target:
                buffer = f"{buffer}\n\n{piece}"
            else:
                out.append(buffer)
                buffer = piece
    if buffer:
        out.append(buffer)
    return out


def _split_long(text: str, maximum: int) -> list[str]:
    if len(text) <= maximum:
        return [text]
    pieces: list[str] = []
    current = ""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if not current:
            current = sentence
        elif len(current) + len(sentence) + 1 <= maximum:
            current = f"{current} {sentence}"
        else:
            pieces.append(current)
            current = sentence
    if current:
        pieces.append(current[:maximum])
    return pieces


def chunk_document(document) -> list[Chunk]:
    """``document`` is an ``apps.rag.sources.SourceDocument``. Returns [] when there is no text."""
    body = document.text
    if document.source_type == SourceType.EMAIL:
        body = strip_email_noise(body)
    body = _normalise(body)
    if not body:
        return []

    header = _header(document)
    limit = MAX_CHUNKS.get(document.source_type, MAX_CHUNKS_PER_SOURCE)
    if limit == 1 or len(body) <= MAX_CHARS:
        bodies = [body[: MAX_CHARS * 2]] if limit == 1 else [body]
    else:
        bodies = _pack(_paragraphs(body), target=TARGET_CHARS, maximum=MAX_CHARS)
        bodies = _merge_runts(bodies)[:limit]

    return [Chunk(index=i, content=f"{header}\n{part}" if header else part) for i, part in enumerate(bodies) if part]


def _merge_runts(parts: list[str]) -> list[str]:
    """Fold a trailing fragment back into the previous chunk rather than indexing a two-word chunk."""
    merged: list[str] = []
    for part in parts:
        if merged and len(part) < MIN_CHARS and len(merged[-1]) + len(part) <= MAX_CHARS:
            merged[-1] = f"{merged[-1]}\n\n{part}"
        else:
            merged.append(part)
    return merged


def _header(document) -> str:
    when = ""
    occurred = getattr(document, "occurred_at", None)
    if occurred is not None:
        when = occurred.strftime("%d %b %Y") if hasattr(occurred, "strftime") else str(occurred)
    title = _normalise(document.title or "")[:160]
    parts = [p for p in (title, when) if p]
    return f"[{' · '.join(parts)}]" if parts else ""
