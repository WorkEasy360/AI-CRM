"""AI input/output hygiene. The model is untrusted; so is every CRM text that reaches it.

- ``crm_block`` wraps retrieved content in a delimited, escaped block labelled as data. Instructions
  inside notes, emails or WhatsApp messages are never followed because the system prompt says so and
  because the content cannot terminate the block (angle brackets are escaped).
- ``injection_score`` flags content that looks like an injection attempt; flagged blocks are marked
  ``untrusted="high"`` and truncated harder.
- ``clean_output`` strips markup and control characters, caps length and rejects leaked canaries.
"""

from __future__ import annotations

import html
import re

CANARY = "KEEL-CANARY-7f3a"
MAX_BLOCK_CHARS = 2000
MAX_FLAGGED_BLOCK_CHARS = 400
MAX_OUTPUT_CHARS = 8000
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_TAGS = re.compile(r"<[^>]{0,200}>")
_INJECTION_PATTERNS = (
    r"ignore (all |the )?(previous|prior|above) instructions",
    r"disregard (all |the )?(previous|prior|above)",
    r"you are now",
    r"new instructions?:",
    r"system prompt",
    r"developer message",
    r"act as (an? )?(admin|administrator|developer|system)",
    r"reveal (your|the) (instructions|prompt|rules)",
    r"\bBEGIN\b.*\bINSTRUCTIONS\b",
    r"</?crm_data",
    r"assistant:",
    r"tool_call",
    r"send (this|the) (email|message) to",
    r"[A-Za-z0-9+/]{120,}={0,2}",  # long base64-looking blobs
)
_INJECTION = re.compile("|".join(f"(?:{p})" for p in _INJECTION_PATTERNS), re.IGNORECASE | re.DOTALL)


def injection_score(text: str) -> int:
    if not text:
        return 0
    return len(_INJECTION.findall(text))


def escape(text: str) -> str:
    return html.escape(_CONTROL.sub("", text or ""), quote=False)


def crm_block(source: str, text: str, *, record_id: str = "", extra: dict[str, str] | None = None) -> str:
    """One delimited, escaped data block. Returns "" for empty content."""
    text = (text or "").strip()
    if not text:
        return ""
    score = injection_score(text)
    cap = MAX_FLAGGED_BLOCK_CHARS if score else MAX_BLOCK_CHARS
    body = escape(text[:cap]) + (" [truncated]" if len(text) > cap else "")
    attrs = [f'source="{escape(source)}"']
    if record_id:
        attrs.append(f'id="{escape(record_id)}"')
    for key, value in (extra or {}).items():
        attrs.append(f'{key}="{escape(str(value))[:120]}"')
    if score:
        attrs.append('untrusted="high"')
    return f"<crm_data {' '.join(attrs)}>{body}</crm_data>"


def clean_output(text: str, *, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    text = _CONTROL.sub("", text or "")
    text = _TAGS.sub("", text)  # markdown only; never HTML
    text = text.replace(CANARY, "")
    text = text.strip()
    if len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0] + "…"
    return text


def looks_like_json(text: str) -> bool:
    return text.strip().startswith("{")


def extract_json(text: str) -> str:
    """Pull the first {...} object out of a response that may be wrapped in a code fence or prose."""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if start >= 0 and end > start else text
