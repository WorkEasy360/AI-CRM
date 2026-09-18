"""HMAC-SHA256 signatures for webhooks, in both directions.

Header format (``Keel-Signature``)::

    t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac with the previous secret>]

The signed message is ``"<t>." + raw body``. Receivers must check the timestamp is recent (replay
window) and compare in constant time. During secret rotation Keel signs with both the new and the
previous secret, so a receiver can switch secrets without dropping deliveries.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time

SIGNATURE_HEADER = "Keel-Signature"
TIMESTAMP_TOLERANCE_SECONDS = 300
SECRET_PREFIX = "whsec_"  # noqa: S105  # nosec B105 - prefix of generated secrets, not a secret


def generate_secret() -> str:
    return SECRET_PREFIX + secrets.token_urlsafe(32)


def compute(secret: str, timestamp: int, body: bytes) -> str:
    message = str(int(timestamp)).encode("ascii") + b"." + body
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def header_value(signing_secrets: list[str], timestamp: int, body: bytes) -> str:
    parts = [f"t={int(timestamp)}"]
    parts += [f"v1={compute(s, timestamp, body)}" for s in signing_secrets if s]
    return ",".join(parts)


def verify(
    header: str | None,
    body: bytes,
    signing_secrets: list[str],
    *,
    tolerance: int = TIMESTAMP_TOLERANCE_SECONDS,
    now: float | None = None,
) -> tuple[bool, str]:
    """Return ``(valid, reason)``. ``reason`` is a code for logs, never shown to the sender in detail."""
    if not header or len(header) > 1024:
        return False, "missing_signature"
    timestamp: int | None = None
    candidates: list[str] = []
    for item in header.split(","):
        key, _, value = item.strip().partition("=")
        if key == "t" and value.isdigit():
            timestamp = int(value)
        elif key == "v1" and value:
            candidates.append(value)
    if timestamp is None or not candidates:
        return False, "malformed_signature"
    current = time.time() if now is None else now
    if abs(current - timestamp) > tolerance:
        return False, "timestamp_out_of_range"
    for secret in signing_secrets:
        if not secret:
            continue
        expected = compute(secret, timestamp, body)
        if any(hmac.compare_digest(expected, candidate) for candidate in candidates):
            return True, "ok"
    return False, "bad_signature"
