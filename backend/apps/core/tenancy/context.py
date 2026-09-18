"""Tenant context: the single source of truth for "which organization is this code acting for".

The context lives in a ContextVar (thread/async safe) and is mirrored into PostgreSQL
transaction-local settings so Row Level Security enforces the same boundary in the database.

Rules:
- Request handling binds the context from the authenticated session (never from client input).
- Background jobs bind it explicitly from task arguments.
- ``system_context(reason)`` is the only way to run without an organization; it is logged.
"""

from __future__ import annotations

import contextlib
import sys
import uuid
from collections.abc import Iterator
from contextvars import ContextVar, Token
from dataclasses import dataclass

import structlog
from django.db import connections, transaction

from apps.core.exceptions import TenantContextMissing

log = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class TenantContext:
    organization_id: uuid.UUID | None
    user_id: uuid.UUID | None = None
    membership_id: uuid.UUID | None = None
    is_system: bool = False
    reason: str | None = None

    @property
    def is_tenant(self) -> bool:
        return self.organization_id is not None and not self.is_system


_context: ContextVar[TenantContext | None] = ContextVar("keel_tenant_context", default=None)


def get_context() -> TenantContext | None:
    return _context.get()


def require_context() -> TenantContext:
    ctx = _context.get()
    if ctx is None:
        raise TenantContextMissing("No tenant context is bound; use tenant_context() or system_context().")
    return ctx


def apply_db_context(ctx: TenantContext | None, using: str = "default") -> None:
    """Mirror the context into transaction-local PostgreSQL settings used by RLS policies.

    ``set_config(..., is_local=true)`` is equivalent to ``SET LOCAL`` and is reset at the end of the
    transaction, which makes it safe with transaction-mode connection pooling.
    """
    conn = connections[using]
    if not conn.in_atomic_block:
        raise RuntimeError("apply_db_context() must run inside a transaction (SET LOCAL semantics).")
    org = str(ctx.organization_id) if ctx and ctx.organization_id else ""
    user = str(ctx.user_id) if ctx and ctx.user_id else ""
    system = "on" if ctx and ctx.is_system else ""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT set_config('app.current_org', %s, true),"
            " set_config('app.current_user', %s, true),"
            " set_config('app.system', %s, true)",
            [org, user, system],
        )


def set_db_user(user_id: uuid.UUID | None, using: str = "default") -> None:
    """Set only the user half of the DB context (used before the organization is resolved)."""
    conn = connections[using]
    if not conn.in_atomic_block:
        raise RuntimeError("set_db_user() must run inside a transaction.")
    with conn.cursor() as cur:
        cur.execute("SELECT set_config('app.current_user', %s, true)", [str(user_id) if user_id else ""])


@contextlib.contextmanager
def bind_context(
    ctx: TenantContext, *, apply_db: bool = True, restore_db: bool = True, using: str = "default"
) -> Iterator[TenantContext]:
    """Bind ``ctx`` for the duration of the block, restoring the previous context afterwards.

    If no transaction is open, one is opened so that the DB-level context has SET LOCAL semantics.
    ``restore_db=False`` skips re-applying the previous DB context on exit; only for callers that
    restore it themselves once (the request middleware) instead of once per nested level.
    """
    token: Token[TenantContext | None] = _context.set(ctx)
    previous = token.old_value if token.old_value is not Token.MISSING else None
    atomic_cm = None
    try:
        if apply_db:
            conn = connections[using]
            if not conn.in_atomic_block:
                atomic_cm = transaction.atomic(using=using)
                atomic_cm.__enter__()
            apply_db_context(ctx, using=using)
        yield ctx
    except BaseException:
        if atomic_cm is not None:
            atomic_cm.__exit__(*sys.exc_info())
            atomic_cm = None
        raise
    finally:
        _context.reset(token)
        if apply_db:
            if atomic_cm is not None:
                atomic_cm.__exit__(None, None, None)
            elif restore_db and connections[using].in_atomic_block:
                apply_db_context(previous, using=using)


@contextlib.contextmanager
def tenant_atomic(using: str = "default") -> Iterator[None]:
    """Open one bounded transaction and (re-)apply the bound tenant context inside it.

    The companion of ``tenant_task(atomic=False)``. Because ``app.current_org`` is written with
    ``SET LOCAL``, it lives exactly as long as one transaction: a long task that commits in batches
    has to re-apply it every time it opens a new one. Every statement a non-atomic task issues must
    sit inside this block -- outside it the RLS policies see no organization and fail closed, so the
    mistake shows up as rows that cannot be read or written, never as a cross-tenant leak.
    """
    ctx = require_context()
    with transaction.atomic(using=using):
        apply_db_context(ctx, using=using)
        yield


@contextlib.contextmanager
def tenant_context(
    organization_id: uuid.UUID,
    *,
    user_id: uuid.UUID | None = None,
    membership_id: uuid.UUID | None = None,
    reason: str | None = None,
    apply_db: bool = True,
) -> Iterator[TenantContext]:
    if organization_id is None:
        raise TenantContextMissing("tenant_context() requires an organization id.")
    ctx = TenantContext(
        organization_id=organization_id,
        user_id=user_id,
        membership_id=membership_id,
        reason=reason,
    )
    with bind_context(ctx, apply_db=apply_db) as bound:
        yield bound


@contextlib.contextmanager
def system_context(reason: str, *, apply_db: bool = True) -> Iterator[TenantContext]:
    """Run without tenant scoping. Every use is logged with its reason; keep uses rare and reviewed."""
    if not reason or not reason.strip():
        raise ValueError("system_context() requires a non-empty reason.")
    log.info("tenancy.system_context", reason=reason)
    ctx = TenantContext(organization_id=None, is_system=True, reason=reason)
    with bind_context(ctx, apply_db=apply_db) as bound:
        yield bound
