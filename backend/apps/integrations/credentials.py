"""Sealed credential storage for integrations, on top of ``apps.core.crypto`` (MultiFernet, rotatable keys).

Credentials are a JSON object encrypted as one value. They are decrypted only inside provider calls,
never logged, never serialized, and wiped on disconnect.
"""

from __future__ import annotations

import json
from typing import Any

from apps.core import crypto


def seal(data: dict[str, Any]) -> str:
    clean = {k: v for k, v in data.items() if v not in (None, "")}
    return crypto.encrypt(json.dumps(clean, separators=(",", ":"))) if clean else ""


def unseal(token: str) -> dict[str, Any]:
    if not token:
        return {}
    value = json.loads(crypto.decrypt(token))
    return value if isinstance(value, dict) else {}


def merge(token: str, updates: dict[str, Any]) -> str:
    current = unseal(token)
    current.update(updates)
    return seal(current)


def redacted_keys(token: str) -> list[str]:
    """Names of the stored credential fields (for "configured" indicators in the UI), never values."""
    try:
        return sorted(unseal(token).keys())
    except crypto.DecryptionError:
        return []
