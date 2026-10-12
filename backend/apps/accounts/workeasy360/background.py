"""Background jobs and Workeasy360 entitlement: a job that produces a customer business effect asks first.

Request-time enforcement (``entitlement.require``) cannot see work that runs with nobody signed in:
beat sweeps, outbound messages and webhooks, mailbox and external syncs, reminders, AI indexing. Each such
job calls into this module before its effect (the classification is in docs/workeasy360-sso.md):

- The organization is asked about alone (no person), through the same ``entitlement`` module: the same
  cache, single-flight and outage rules. A denial is trusted for ``BACKGROUND_DENIAL_SECONDS`` (900 s), not
  the 60 s a waiting person gets, so an expired organization's jobs cost one question per window.
- Needs ``allow`` and ``write_allowed``: a read-only (suspended) organization may view and export, but its
  jobs must not change anything or reach anyone.
- Denied: the effect is skipped, ``workeasy360.background_skipped`` is logged (organization, task, reason),
  nothing is raised (so nothing retries in a loop) and nothing is deleted or rescheduled: the work is still
  there to resume once access is renewed.
- An outage keeps the last answer; with none the job runs, as for a request. Only organizations linked to
  Workeasy360 are asked: a Keel-only organization has no entitlement to lose.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable
from typing import Any

import structlog

from apps.accounts.models import Organization
from apps.accounts.workeasy360 import config, entitlement
from apps.core.tenancy.context import system_context, tenant_context

log = structlog.get_logger(__name__)

#: A sweep re-reads at most this many times, each time without the organizations found denied, so a denied
#: organization's backlog cannot fill the batch and starve everyone else's work.
MAX_SWEEP_PASSES = 5


def _links(organization_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, uuid.UUID]:
    """{organization id: Workeasy360 organization id} for those linked to Workeasy360."""
    ids = {uuid.UUID(str(i)) for i in organization_ids}
    if not ids:
        return {}
    if len(ids) == 1:
        (only,) = ids
        # One organization (a tenant-bound task): its own context is enough.
        with tenant_context(only, reason="workeasy360.background_entitlement"):
            rows = Organization.objects.filter(pk=only, workeasy360_organization_id__isnull=False).values_list(
                "pk", "workeasy360_organization_id"
            )
            return {pk: link for pk, link in rows if link is not None}
    with system_context("workeasy360.background_entitlement"):
        rows = Organization.objects.filter(pk__in=ids, workeasy360_organization_id__isnull=False).values_list(
            "pk", "workeasy360_organization_id"
        )
        return {pk: link for pk, link in rows if link is not None}


def denied_organizations(organization_ids: Iterable[uuid.UUID], *, task: str) -> set[uuid.UUID]:
    """The organizations among ``organization_ids`` whose jobs must not run now. Each is logged."""
    if not config.is_configured():
        return set()
    denied: set[uuid.UUID] = set()
    for organization_id, workeasy360_id in _links(organization_ids).items():
        access = entitlement.check(workeasy360_id, organization_id=organization_id, background=True)
        if access is None or (access.allowed and access.write_allowed):
            continue
        denied.add(organization_id)
        log.info(
            "workeasy360.background_skipped",
            organization_id=str(organization_id),
            task=task,
            reason=access.reason if not access.allowed else "read_only",
        )
    return denied


def allowed(organization_id: object, *, task: str) -> bool:
    """Whether ``task`` may produce its effect for this organization now."""
    return not denied_organizations([uuid.UUID(str(organization_id))], task=task)


def fetch_allowed(
    fetch: Callable[[set[uuid.UUID]], list[Any]],
    *,
    task: str,
    organization_of: Callable[[Any], uuid.UUID] = lambda row: row[0],
) -> list[Any]:
    """The rows a sweep may act on. ``fetch(excluded)`` reads one bounded batch without the organizations in
    ``excluded``; the organizations found denied are excluded from the next read, so their backlog (which
    stays where it is) never crowds out the others."""
    denied: set[uuid.UUID] = set()
    checked: set[uuid.UUID] = set()
    rows: list[Any] = []
    for _ in range(MAX_SWEEP_PASSES):
        rows = fetch(denied)
        fresh = {organization_of(row) for row in rows} - checked
        checked |= fresh
        newly_denied = denied_organizations(fresh, task=task)
        if not newly_denied:
            break
        denied |= newly_denied
    return [row for row in rows if organization_of(row) not in denied]
