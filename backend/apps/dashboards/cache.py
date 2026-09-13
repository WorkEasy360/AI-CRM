"""Tenant- and permission-aware caching for dashboard aggregates.

Key layout (never shared across organizations, users or permission scopes)::

    keel:dash:{org_id}:v{version}:{membership_id}:{scope_fingerprint}:{period}:{pipeline}

- ``org_id`` and ``membership_id`` bind the entry to one member of one organization.
- ``scope_fingerprint`` hashes the member's effective grants (permission -> scope) and, for team
  scopes, the set of team-mate membership ids. A role change or team change produces a different key,
  so an entry computed with wider rights can never be served after rights were narrowed.
- ``version`` is a per-organization counter bumped by every CRM record write (create, update, archive,
  restore, bulk, stage move, import). A write invalidates every dashboard entry of the organization at
  once; the TTL bounds staleness if the bump was lost (Redis restart).

Redis unavailable: ``cache.get`` returns None under ``CACHE_FAIL_OPEN`` and the dashboard is computed
directly, exactly as before caching existed.
"""

from __future__ import annotations

import contextlib
import hashlib
import uuid
from collections.abc import Callable
from typing import Any

from django.conf import settings
from django.core.cache import cache

from apps.authz.actor import Actor
from apps.authz.catalogue import SCOPE_TEAM

VERSION_TTL = 30 * 24 * 3600


def _version_key(organization_id: uuid.UUID | str) -> str:
    return f"dash:ver:{organization_id}"


def current_version(organization_id: uuid.UUID | str) -> int:
    try:
        return int(cache.get(_version_key(organization_id)) or 0)
    except Exception:
        return 0


def invalidate(organization_id: uuid.UUID | str | None) -> None:
    """Called after any write that can change dashboard numbers. Cheap (one INCR) and never raises."""
    if organization_id is None:
        return
    key = _version_key(organization_id)
    try:
        try:
            cache.incr(key)
        except ValueError:  # key does not exist yet
            cache.add(key, 1, VERSION_TTL)
    except Exception:  # cache down: the TTL takes over
        return


def scope_fingerprint(actor: Actor) -> str:
    grants = sorted(f"{perm}={scope}" for perm, scope in actor.grants.items())
    parts = [actor.role_key, ",".join(grants)]
    if any(scope == SCOPE_TEAM for scope in actor.grants.values()):
        parts.append(",".join(sorted(str(m) for m in actor.team_member_ids)))
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]


def cache_key(actor: Actor, *, period: str, pipeline_id: uuid.UUID | None) -> str:
    org = actor.organization.pk
    return (
        f"dash:{org}:v{current_version(org)}:{actor.membership.pk}:{scope_fingerprint(actor)}:"
        f"{period}:{pipeline_id or 'default'}"
    )


def get_or_compute(actor: Actor, *, period: str, pipeline_id: uuid.UUID | None, compute: Callable[[], Any]) -> Any:
    ttl = settings.DASHBOARD_CACHE_SECONDS
    if ttl <= 0:
        return compute()
    key = cache_key(actor, period=period, pipeline_id=pipeline_id)
    try:
        hit = cache.get(key)
    except Exception:
        hit = None
    if hit is not None:
        return hit
    value = compute()
    with contextlib.suppress(Exception):  # cache down: serve the computed value, the next call recomputes
        cache.set(key, value, ttl)
    return value
