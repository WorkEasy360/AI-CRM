"""Private file storage for import uploads and export results.

Keys are generated server-side (organization id + random token) so client input never influences a
path. Files are never served directly: downloads go through an authenticated, audited endpoint.

Two backends behind the same functions, selected by ``PRIVATE_STORAGE_BACKEND``:

- ``filesystem``: a single local process (development, tests). Not shareable between instances.
- ``s3``: production. A private bucket (block public access, SSE-KMS, TLS-only policy, lifecycle
  expiry) shared by every API instance and worker. Downloads are handed out as short-lived signed URLs
  (``PRIVATE_STORAGE_URL_TTL_SECONDS``) that force ``Content-Disposition: attachment`` and a CSV content
  type, so object bytes never stream through a Django thread.
"""

from __future__ import annotations

import contextlib
import re
import secrets
import threading
import uuid
from pathlib import Path
from typing import Any, Protocol

from django.conf import settings

_KEY_RE = re.compile(r"^[0-9a-f-]{36}/(imports|exports|email)/[0-9a-f]{32}\.(csv|bin)$")
_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]")
CONTENT_TYPE = "text/csv; charset=utf-8"


def new_key(organization_id: uuid.UUID, kind: str) -> str:
    if kind not in {"imports", "exports", "email"}:
        raise ValueError(kind)
    ext = "bin" if kind == "email" else "csv"
    return f"{organization_id}/{kind}/{secrets.token_hex(16)}.{ext}"


def validate_key(key: str) -> str:
    if not _KEY_RE.match(key):
        raise ValueError("Invalid storage key.")
    return key


def organization_of(key: str) -> uuid.UUID:
    """The organization a key belongs to; callers use it to refuse cross-tenant reads defensively."""
    return uuid.UUID(validate_key(key).split("/", 1)[0])


class Backend(Protocol):
    supports_signed_urls: bool

    def write(self, key: str, data: bytes) -> int: ...
    def read(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...
    def signed_download_url(self, key: str, filename: str) -> str: ...


# ----------------------------------------------------------------------------- filesystem


class FilesystemBackend:
    supports_signed_urls = False

    def _root(self) -> Path:
        root = Path(settings.PRIVATE_STORAGE_ROOT)
        root.mkdir(parents=True, exist_ok=True)
        return root

    def _path(self, key: str) -> Path:
        validate_key(key)
        path = (self._root() / key).resolve()
        if self._root().resolve() not in path.parents:
            raise ValueError("Invalid storage key.")
        return path

    def write(self, key: str, data: bytes) -> int:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return len(data)

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        try:
            return self._path(key).exists()
        except ValueError:
            return False

    def delete(self, key: str) -> None:
        with contextlib.suppress(ValueError):
            self._path(key).unlink(missing_ok=True)

    def signed_download_url(self, key: str, filename: str) -> str:
        raise NotImplementedError("The filesystem backend streams downloads through the API.")


# ----------------------------------------------------------------------------- s3


class S3Backend:
    supports_signed_urls = True

    def __init__(self) -> None:
        self._client: Any = None
        self._lock = threading.Lock()

    @property
    def bucket(self) -> str:
        bucket = settings.PRIVATE_STORAGE_BUCKET
        if not bucket:
            raise RuntimeError("PRIVATE_STORAGE_BUCKET is not configured.")
        return bucket

    def client(self) -> Any:
        if self._client is None:
            with self._lock:
                if self._client is None:
                    import boto3
                    from botocore.config import Config

                    self._client = boto3.client(
                        "s3",
                        region_name=settings.AWS_REGION,
                        config=Config(
                            connect_timeout=3,
                            read_timeout=30,
                            retries={"max_attempts": 3, "mode": "standard"},
                            signature_version="s3v4",
                        ),
                    )
        return self._client

    def _encryption(self) -> dict[str, str]:
        if settings.PRIVATE_STORAGE_KMS_KEY_ID:
            return {"ServerSideEncryption": "aws:kms", "SSEKMSKeyId": settings.PRIVATE_STORAGE_KMS_KEY_ID}
        return {"ServerSideEncryption": "aws:kms"}  # bucket default key

    def write(self, key: str, data: bytes) -> int:
        validate_key(key)
        self.client().put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=CONTENT_TYPE, **self._encryption())
        return len(data)

    def read(self, key: str) -> bytes:
        validate_key(key)
        response = self.client().get_object(Bucket=self.bucket, Key=key)
        return response["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            validate_key(key)
        except ValueError:
            return False
        from botocore.exceptions import ClientError

        try:
            self.client().head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise

    def delete(self, key: str) -> None:
        with contextlib.suppress(ValueError):
            validate_key(key)
            self.client().delete_object(Bucket=self.bucket, Key=key)

    def signed_download_url(self, key: str, filename: str) -> str:
        validate_key(key)
        safe_name = _FILENAME_RE.sub("_", filename)[:120] or "export.csv"
        return self.client().generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self.bucket,
                "Key": key,
                "ResponseContentDisposition": f'attachment; filename="{safe_name}"',
                "ResponseContentType": CONTENT_TYPE,
                "ResponseCacheControl": "no-store",
            },
            ExpiresIn=settings.PRIVATE_STORAGE_URL_TTL_SECONDS,
        )


# ----------------------------------------------------------------------------- module API

_backends: dict[str, Backend] = {}


def backend() -> Backend:
    name = settings.PRIVATE_STORAGE_BACKEND
    if name not in _backends:
        if name == "s3":
            _backends[name] = S3Backend()
        elif name == "filesystem":
            _backends[name] = FilesystemBackend()
        else:
            raise RuntimeError(f"Unknown PRIVATE_STORAGE_BACKEND {name!r} (expected 'filesystem' or 's3').")
    return _backends[name]


def reset_backend_cache() -> None:
    """Tests switch backends via settings overrides."""
    _backends.clear()


def write(key: str, data: bytes) -> int:
    return backend().write(key, data)


def read(key: str) -> bytes:
    return backend().read(key)


def exists(key: str) -> bool:
    return backend().exists(key)


def delete(key: str) -> None:
    backend().delete(key)


def supports_signed_urls() -> bool:
    return backend().supports_signed_urls


def signed_download_url(key: str, filename: str) -> str:
    return backend().signed_download_url(key, filename)
