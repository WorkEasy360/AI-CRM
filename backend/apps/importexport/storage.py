"""Private file storage for import uploads and export results.

Keys are generated server-side (organization id + random token) so client input never influences a
path. Files are never served directly: downloads go through an authenticated, audited endpoint that
streams the bytes with ``Content-Disposition: attachment``. Object storage with signed URLs replaces
the filesystem backend in Phase 6 behind the same two functions.
"""

from __future__ import annotations

import contextlib
import re
import secrets
import uuid
from pathlib import Path

from django.conf import settings

_KEY_RE = re.compile(r"^[0-9a-f-]{36}/(imports|exports)/[0-9a-f]{32}\.csv$")


def _root() -> Path:
    root = Path(settings.PRIVATE_STORAGE_ROOT)
    root.mkdir(parents=True, exist_ok=True)
    return root


def new_key(organization_id: uuid.UUID, kind: str) -> str:
    if kind not in {"imports", "exports"}:
        raise ValueError(kind)
    return f"{organization_id}/{kind}/{secrets.token_hex(16)}.csv"


def _path(key: str) -> Path:
    if not _KEY_RE.match(key):
        raise ValueError("Invalid storage key.")
    path = (_root() / key).resolve()
    if _root().resolve() not in path.parents:
        raise ValueError("Invalid storage key.")
    return path


def write(key: str, data: bytes) -> int:
    path = _path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return len(data)


def read(key: str) -> bytes:
    return _path(key).read_bytes()


def exists(key: str) -> bool:
    try:
        return _path(key).exists()
    except ValueError:
        return False


def delete(key: str) -> None:
    with contextlib.suppress(ValueError):
        _path(key).unlink(missing_ok=True)
