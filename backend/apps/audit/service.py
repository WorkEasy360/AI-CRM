"""``record()`` is the only way to write audit events. It redacts secrets and never raises to callers."""

from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import uuid
from collections.abc import Iterator
from contextvars import ContextVar
from typing import Any

import structlog
from django.http import HttpRequest

from apps.audit.models import AuditEvent
from apps.core.tenancy.context import get_context, system_context

log = structlog.get_logger(__name__)

REDACT_KEYS = frozenset(
    {
        "password",
        "password1",
        "password2",
        "token",
        "secret",
        "authorization",
        "cookie",
        "key",
        "recovery_code",
        "code",
        "csrfmiddlewaretoken",
        "access_token",
        "refresh_token",
        "api_key",
    }
)
REDACTED = "[redacted]"

# Set while an integration (API credential, sync job, inbound webhook) acts: events written meanwhile are
# attributed to it (actor_type=integration plus its id) even though they run through a member's grants.
_integration: ContextVar[dict[str, str] | None] = ContextVar("audit_integration", default=None)


@contextlib.contextmanager
def acting_integration(kind: str, identifier: Any) -> Iterator[None]:
    token = _integration.set({"integration_kind": kind, "integration_id": str(identifier)})
    try:
        yield
    finally:
        _integration.reset(token)


_MAX_METADATA_STR = 512


def redact(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return REDACTED
    if isinstance(value, dict):
        return {str(k): (REDACTED if str(k).lower() in REDACT_KEYS else redact(v, depth + 1)) for k, v in value.items()}
    if isinstance(value, list | tuple | set):
        return [redact(v, depth + 1) for v in list(value)[:50]]
    if isinstance(value, str) and len(value) > _MAX_METADATA_STR:
        return value[:_MAX_METADATA_STR] + "…"
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    return str(value)


def client_ip(request: HttpRequest | None) -> str | None:
    if request is None:
        return None
    raw = request.META.get("REMOTE_ADDR")
    if not raw:
        return None
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return None


def user_agent_hash(request: HttpRequest | None) -> str:
    if request is None:
        return ""
    ua = request.META.get("HTTP_USER_AGENT", "")
    return hashlib.sha256(ua.encode("utf-8", "ignore")).hexdigest()[:32] if ua else ""


def record(
    action: str,
    *,
    request: HttpRequest | None = None,
    user: Any | None = None,
    organization_id: uuid.UUID | None = None,
    actor_type: str = AuditEvent.ActorType.USER,
    resource: Any | None = None,
    resource_type: str | None = None,
    resource_id: Any | None = None,
    metadata: dict[str, Any] | None = None,
) -> AuditEvent | None:
    """Write an audit event. Organization defaults to the bound tenant context."""
    ctx = get_context()
    if organization_id is None and ctx is not None and ctx.organization_id is not None:
        organization_id = ctx.organization_id
    if user is None and request is not None:
        req_user = getattr(request, "user", None)
        if req_user is not None and req_user.is_authenticated:
            user = req_user
    integration = _integration.get()
    credential_id = getattr(request, "api_credential_id", None) if request is not None else None
    if integration is None and credential_id:
        integration = {"integration_kind": "api_credential", "integration_id": str(credential_id)}
    if integration is not None:
        actor_type = AuditEvent.ActorType.INTEGRATION
        metadata = {**(metadata or {}), **integration}
    if resource is not None:
        resource_type = resource_type or type(resource).__name__.lower()
        resource_id = resource_id if resource_id is not None else getattr(resource, "pk", None)

    event = AuditEvent(
        organization_id=organization_id,
        actor_user=user if (user is not None and getattr(user, "is_authenticated", True)) else None,
        actor_type=actor_type,
        action=action,
        resource_type=resource_type or "",
        resource_id=str(resource_id) if resource_id is not None else "",
        ip=client_ip(request),
        user_agent_hash=user_agent_hash(request),
        request_id=getattr(request, "request_id", "") or "",
        metadata=redact(metadata or {}),
    )
    try:
        needs_system = organization_id is None or ctx is None or ctx.organization_id != organization_id
        if needs_system:
            with system_context(reason=f"audit.record:{action}"):
                event.save(force_insert=True)
        else:
            event.save(force_insert=True)
    except Exception:
        log.exception("audit.record_failed", action=action)
        return None
    log.info(
        "audit.event",
        action=action,
        organization_id=str(organization_id) if organization_id else None,
        actor_user_id=str(getattr(user, "pk", "")) or None,
        resource_type=event.resource_type,
        resource_id=event.resource_id,
    )
    return event
