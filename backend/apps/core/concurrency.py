"""Optimistic concurrency helpers (ADR-0007).

Clients send the ``version`` they last saw either as ``If-Match: "<n>"`` or as ``version`` in the body.
``expected_version()`` extracts it; ``save_with_version()`` performs the guarded update and raises
``ConflictError`` (409) when the row moved on. Services call both; views never touch ``version`` directly.
"""

from __future__ import annotations

import re
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.core.exceptions import ConflictError, DomainError

_IF_MATCH_RE = re.compile(r'^\s*(?:W/)?"?(\d{1,9})"?\s*$')


def expected_version(request: Any, data: Any = None, *, required: bool = True) -> int | None:
    """Read the client's expected version from ``If-Match`` or the request body."""
    header = request.META.get("HTTP_IF_MATCH", "") if request is not None else ""
    if header:
        m = _IF_MATCH_RE.match(header)
        if not m:
            raise DomainError("If-Match must contain the numeric version.", code="invalid_if_match", status_code=428)
        return int(m.group(1))
    body = data if data is not None else (getattr(request, "data", None) or {})
    raw = body.get("version") if isinstance(body, dict) else None
    if raw is None:
        if required:
            raise DomainError(
                "This update requires the record version (If-Match header or 'version' field).",
                code="version_required",
                status_code=428,
            )
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise DomainError("version must be an integer.", code="invalid_version") from exc
    if value < 1:
        raise DomainError("version must be positive.", code="invalid_version")
    return value


def save_with_version(instance: Any, expected: int | None, update_fields: list[str]) -> Any:
    """Apply an ``UPDATE ... WHERE id = ? AND version = ?``; bump ``version``; raise 409 on mismatch.

    ``update_fields`` must contain only fields already set on ``instance``. Without ``expected`` the
    save is unguarded (used by internal callers that already hold a row lock).
    """
    manager = type(instance).objects
    fields = {f: getattr(instance, f) for f in update_fields if f not in {"version", "updated_at"}}
    fields["updated_at"] = timezone.now()
    current = instance.version
    with transaction.atomic():
        qs = manager.filter(pk=instance.pk)
        if expected is not None:
            if expected != current:
                raise ConflictError(
                    "The record was modified by someone else. Reload and try again.", code="version_conflict"
                )
            qs = qs.filter(version=expected)
        updated = qs.update(version=current + 1, **fields)
    if updated != 1:
        raise ConflictError("The record was modified by someone else. Reload and try again.", code="version_conflict")
    instance.version = current + 1
    instance.updated_at = fields["updated_at"]
    return instance
