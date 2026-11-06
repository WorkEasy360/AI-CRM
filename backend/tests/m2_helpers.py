"""Shared helpers for the Milestone 2 tests: plans, usage counters, permission sets, hierarchy, events."""

from __future__ import annotations

import contextlib
from collections.abc import Iterator

from apps.accounts.models import Membership
from apps.authz.models import Role
from apps.billing import entitlements
from apps.billing.models import Subscription, UsageCounter
from apps.core import domain_events
from apps.core.tenancy.context import tenant_context

SUBORDINATE_GRANTS = {
    "org.view": "all",
    "search.use": "all",
    "pipelines.view": "all",
    "contacts.view": "subordinates",
    "contacts.create": "all",
    "contacts.update": "subordinates",
    "contacts.export": "all",
    "deals.view": "subordinates",
    "deals.create": "all",
    "deals.update": "subordinates",
    "deals.change_stage": "subordinates",
    "deals.export": "all",
}


def set_plan(bundle, edition: str, *, status: str = "active", seats: int = 0) -> None:
    with tenant_context(bundle.org.pk, reason="test.set_plan"):
        Subscription.objects.update(
            edition=edition, status=status, seats=seats, trial_ends_at=None, grandfathered=False
        )


def set_usage(bundle, metric: str, used: int) -> None:
    with tenant_context(bundle.org.pk, reason="test.set_usage"):
        UsageCounter.objects.update_or_create(
            metric=metric, period_key=entitlements.period_key(metric), defaults={"used": used}
        )


def usage(bundle, metric: str = "records") -> int:
    with tenant_context(bundle.org.pk, reason="test.usage"):
        return entitlements.usage(bundle.org, metric)


def restrict(owner_client, role_key: str, entity_type: str, rules: list[dict]) -> None:
    resp = owner_client.put(
        f"/api/v1/roles/{role_key}/field-permissions/", {"entity_type": entity_type, "rules": rules}, format="json"
    )
    assert resp.status_code == 200, resp.content


def profile(owner_client, name: str = "Field sales", grants: dict | None = None) -> str:
    resp = owner_client.post("/api/v1/roles/", {"name": name, "grants": grants or SUBORDINATE_GRANTS}, format="json")
    assert resp.status_code == 201, resp.content
    return resp.json()["key"]


def hierarchy(owner_client, name: str, parent: str | None = None) -> str:
    resp = owner_client.post("/api/v1/hierarchy-roles/", {"name": name, "parent_id": parent}, format="json")
    assert resp.status_code == 201, resp.content
    return resp.json()["id"]


def member_with(bundle, make_member, role_key: str, hierarchy_role_id=None) -> Membership:
    member = make_member(bundle, "viewer")
    with tenant_context(bundle.org.pk, reason="test"):
        Membership.objects.filter(pk=member.pk).update(
            role=Role.objects.get(key=role_key), hierarchy_role_id=hierarchy_role_id
        )
        return Membership.objects.select_related("user").get(pk=member.pk)


def manager_and_reps(org, owner_client, make_member):
    """A manager with two reps under them and an outsider, all on the subordinates permission set."""
    key = profile(owner_client)
    boss = hierarchy(owner_client, "Manager")
    reps = hierarchy(owner_client, "Rep", boss)
    manager = member_with(org, make_member, key, boss)
    rep1 = member_with(org, make_member, key, reps)
    rep2 = member_with(org, make_member, key, reps)
    outsider = member_with(org, make_member, key, None)
    return manager, rep1, rep2, outsider


@contextlib.contextmanager
def captured_events() -> Iterator[list[domain_events.RecordChanged]]:
    """Collect every RecordChanged published inside the block."""
    seen: list[domain_events.RecordChanged] = []

    def _grab(event: domain_events.RecordChanged) -> None:
        seen.append(event)

    domain_events.subscribe(_grab, critical=False)
    try:
        yield seen
    finally:
        domain_events._best_effort.remove(_grab)


def in_org(bundle):
    return tenant_context(bundle.org.pk, reason="test")
