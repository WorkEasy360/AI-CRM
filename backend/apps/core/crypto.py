"""Symmetric encryption for stored provider secrets (OAuth tokens, API tokens).

Fernet (AES-128-CBC + HMAC-SHA256, versioned, timestamped) keyed from ``MESSAGING_ENCRYPTION_KEYS``:
a comma-separated list of urlsafe-base64 32-byte keys, first key encrypts, every key may decrypt, so
rotation is "prepend a new key, re-encrypt lazily, drop the old key later". Outside production a key
is derived from ``SECRET_KEY`` so development works without extra configuration; production refuses
to start without an explicit key (checked in ``config.settings.prod``).
"""

from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings


class DecryptionError(Exception):
    """The stored value cannot be decrypted with any configured key."""


def _derived_dev_key() -> bytes:
    digest = hashlib.sha256(f"messaging:{settings.SECRET_KEY}".encode()).digest()
    return base64.urlsafe_b64encode(digest)


@lru_cache(maxsize=1)
def _fernet() -> MultiFernet:
    raw = getattr(settings, "MESSAGING_ENCRYPTION_KEYS", "") or ""
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    if not keys:
        if getattr(settings, "ENVIRONMENT", "development") == "production":
            raise RuntimeError("MESSAGING_ENCRYPTION_KEYS must be set in production.")
        keys = [_derived_dev_key().decode()]
    return MultiFernet([Fernet(k.encode() if isinstance(k, str) else k) for k in keys])


def reset_key_cache() -> None:
    _fernet.cache_clear()


def encrypt(value: str) -> str:
    if value is None or value == "":
        return ""
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise DecryptionError("Stored secret cannot be decrypted with the configured keys.") from exc


def rotate(token: str) -> str:
    """Re-encrypt with the current primary key (no-op when it already is)."""
    if not token:
        return ""
    return _fernet().rotate(token.encode("ascii")).decode("ascii")


def generate_key() -> str:
    return Fernet.generate_key().decode("ascii")
