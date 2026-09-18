"""Celery integration: every task that touches tenant data must declare its tenant explicitly."""

from __future__ import annotations

import functools
import uuid
from collections.abc import Callable
from typing import Any

from celery import shared_task

from apps.core.exceptions import TenantContextMissing
from apps.core.tenancy.context import bind_context, tenant_context


def tenant_task(*task_args: Any, atomic: bool = True, **task_kwargs: Any) -> Callable[[Callable[..., Any]], Any]:
    """Like ``shared_task`` but requires ``organization_id`` (and optionally ``actor_membership_id``).

    ``atomic=True`` (the default) runs the whole task body inside one transaction, which is what a
    short task wants: it either happened or it did not.

    ``atomic=False`` binds the tenant context *without* opening a transaction. It is for tasks that
    must commit as they go -- a message send that has to record "I am about to call the provider"
    before it calls the provider, an import that has to checkpoint progress while it runs. Such a
    task opens its own bounded transactions with ``tenant_atomic()``; statements issued outside one
    have no RLS context and fail closed (see ``apps.core.tenancy.context.tenant_atomic``).
    """

    def decorator(func: Callable[..., Any]) -> Any:
        @functools.wraps(func)
        def wrapper(*args: Any, organization_id: str | uuid.UUID | None = None, **kwargs: Any) -> Any:
            if organization_id is None:
                raise TenantContextMissing(f"Task {func.__name__} requires organization_id.")
            org_id = uuid.UUID(str(organization_id))
            membership = kwargs.get("actor_membership_id")
            membership_id = uuid.UUID(str(membership)) if membership else None
            reason = f"task:{func.__name__}"
            if atomic:
                with tenant_context(org_id, membership_id=membership_id, reason=reason):
                    return func(*args, organization_id=org_id, **kwargs)
            from apps.core.tenancy.context import TenantContext

            ctx = TenantContext(organization_id=org_id, membership_id=membership_id, reason=reason)
            with bind_context(ctx, apply_db=False):
                return func(*args, organization_id=org_id, **kwargs)

        return shared_task(*task_args, **task_kwargs)(wrapper)

    return decorator
