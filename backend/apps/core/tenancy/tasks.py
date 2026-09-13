"""Celery integration: every task that touches tenant data must declare its tenant explicitly."""

from __future__ import annotations

import functools
import uuid
from collections.abc import Callable
from typing import Any

from celery import shared_task

from apps.core.exceptions import TenantContextMissing
from apps.core.tenancy.context import tenant_context


def tenant_task(*task_args: Any, **task_kwargs: Any) -> Callable[[Callable[..., Any]], Any]:
    """Like ``shared_task`` but requires ``organization_id`` (and optionally ``actor_membership_id``).

    The task body runs inside ``tenant_context`` (which also opens a transaction), so scoped
    managers and RLS both apply. A call without ``organization_id`` fails before any query runs.
    """

    def decorator(func: Callable[..., Any]) -> Any:
        @functools.wraps(func)
        def wrapper(*args: Any, organization_id: str | uuid.UUID | None = None, **kwargs: Any) -> Any:
            if organization_id is None:
                raise TenantContextMissing(f"Task {func.__name__} requires organization_id.")
            org_id = uuid.UUID(str(organization_id))
            membership = kwargs.get("actor_membership_id")
            membership_id = uuid.UUID(str(membership)) if membership else None
            with tenant_context(org_id, membership_id=membership_id, reason=f"task:{func.__name__}"):
                return func(*args, organization_id=org_id, **kwargs)

        return shared_task(*task_args, **task_kwargs)(wrapper)

    return decorator
