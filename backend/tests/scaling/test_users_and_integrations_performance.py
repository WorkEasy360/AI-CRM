"""Performance guards for user management and the Integration Hub: bounded queries, bounded batches."""

from __future__ import annotations

import pytest
from allauth.mfa.models import Authenticator
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.core.tenancy.context import tenant_context
from apps.integrations import delivery, events
from apps.integrations.models import IntegrationEvent
from apps.teams.models import Team, TeamMembership

pytestmark = pytest.mark.django_db


def _members_list_queries(client) -> int:
    with CaptureQueriesContext(connection) as ctx:
        assert client.get("/api/v1/members/").status_code == 200
    return len(ctx.captured_queries)


def test_member_list_query_count_does_not_grow_with_members(org_a, owner_client, make_member):
    with tenant_context(org_a.org.pk):
        team = Team.objects.create(name="Field")
    for _ in range(3):
        member = make_member(org_a, "sales_rep")
        Authenticator.objects.create(user=member.user, type=Authenticator.Type.TOTP, data={})
        with tenant_context(org_a.org.pk):
            TeamMembership.objects.create(team=team, membership=member)
    _members_list_queries(owner_client)  # warm-up: first request of a session does one-time bookkeeping
    few = _members_list_queries(owner_client)
    for _ in range(15):
        member = make_member(org_a, "viewer")
        with tenant_context(org_a.org.pk):
            TeamMembership.objects.create(team=team, membership=member)
    many = _members_list_queries(owner_client)
    assert many <= few, f"teams / MFA / last login must be batch-loaded ({few} -> {many} queries)"


def test_crm_saves_without_integrations_add_no_outbox_work(org_a, crm):
    crm.make_contact(org_a)  # warms the per-organization "targets" cache
    with CaptureQueriesContext(connection) as warm:
        crm.make_contact(org_a)
    with tenant_context(org_a.org.pk):
        assert IntegrationEvent.objects.count() == 0
    assert not any("integrations_" in q["sql"] for q in warm.captured_queries)


def test_dispatch_query_count_is_bounded_by_destinations_not_history(org_a, crm):
    with tenant_context(org_a.org.pk):
        for i in range(5):
            crm.make_webhook_subscription(org_a, name=f"hook {i}", url=f"https://hooks{i}.example.com/k")
    events.invalidate_targets(org_a.org.pk)
    contacts = [crm.make_contact(org_a) for _ in range(20)]
    with tenant_context(org_a.org.pk):
        first = IntegrationEvent.objects.get(entity_id=contacts[0].pk)
        with CaptureQueriesContext(connection) as ctx:
            created = delivery.dispatch(first)
    assert len(created) == 5
    # one subscription read + one insert (with savepoint) per destination + the event update
    assert len(ctx.captured_queries) <= 5 * 3 + 5
