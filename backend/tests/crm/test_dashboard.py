"""Dashboard summary: numbers computed inside the actor's view scope, never across tenants."""

from __future__ import annotations

from datetime import timedelta
from types import MappingProxyType

import pytest
from django.utils import timezone

from apps.authz.actor import Actor
from apps.core.tenancy.context import tenant_context
from apps.dashboards import service
from apps.deals.models import Deal
from tests.factories import stage_named

pytestmark = pytest.mark.django_db


def _seed(crm, org, owner=None):
    pipeline = crm.make_pipeline(org)
    company = crm.make_company(org, owner=owner, name="Globex")
    other = crm.make_company(org, owner=owner, name="Initech")
    crm.make_contact(org, owner=owner)
    crm.make_contact(org, owner=owner)
    crm.make_deal(org, owner=owner, company=company, amount="1000.00", amount_base="1000.00")
    crm.make_deal(
        org, owner=owner, company=other, stage=stage_named(pipeline, "Proposal"), amount="250.00", amount_base="250.00"
    )
    won = crm.make_deal(
        org,
        owner=owner,
        company=company,
        stage=stage_named(pipeline, "Closed won"),
        amount="5000.00",
        amount_base="5000.00",
    )
    crm.make_deal(org, owner=owner, stage=stage_named(pipeline, "Closed lost"), amount="700.00", amount_base="700.00")
    return pipeline, company, won


def test_owner_sees_organization_wide_numbers(org_a, owner_client, crm):
    pipeline, company, _ = _seed(crm, org_a)
    resp = owner_client.get("/api/v1/dashboard/")
    assert resp.status_code == 200, resp.content
    data = resp.json()
    assert data["period"] == "30d"
    assert data["currency"] == org_a.org.base_currency
    assert data["contacts_created"] == 2
    assert data["deals_won"] == {"count": 1, "amount": "5000.00"}
    assert data["deals_lost"] == {"count": 1, "amount": "700.00"}
    assert data["open_pipeline"] == {"count": 2, "amount": "1250.00"}
    assert data["activities"]["tasks_completed"] == 0 and data["activities"]["tasks_due"] == 0

    by_stage = data["deals_by_stage"]
    assert by_stage["pipeline"]["id"] == str(pipeline.pk)
    counts = {s["name"]: (s["count"], s["amount"]) for s in by_stage["stages"]}
    assert counts["Qualification"] == (1, "1000.00")
    assert counts["Proposal"] == (1, "250.00")
    assert counts["Closed won"] == (1, "5000.00")
    assert counts["Closed lost"] == (1, "700.00")
    assert counts["Negotiation"] == (0, "0.00")

    trend = data["revenue_trend"]
    assert len(trend) == 6
    assert trend[-1]["month"] == timezone.now().date().isoformat()[:7]
    assert trend[-1] == {"month": trend[-1]["month"], "count": 1, "amount": "5000.00"}
    assert all(t["count"] == 0 for t in trend[:-1])

    top = data["top_companies"]
    assert [t["name"] for t in top] == ["Globex", "Initech"]
    assert top[0] == {"id": str(company.pk), "name": "Globex", "count": 2, "amount": "6000.00"}


def test_period_filter_and_validation(org_a, owner_client, crm):
    pipeline, _, won = _seed(crm, org_a)
    with tenant_context(org_a.org.pk, reason="test.dashboard"):
        Deal.objects.filter(pk=won.pk).update(closed_at=timezone.now() - timedelta(days=10))
    assert owner_client.get("/api/v1/dashboard/?period=7d").json()["deals_won"]["count"] == 0
    assert owner_client.get("/api/v1/dashboard/?period=30d").json()["deals_won"]["count"] == 1
    assert owner_client.get("/api/v1/dashboard/?period=2d").status_code == 400
    assert owner_client.get("/api/v1/dashboard/?pipeline=not-a-uuid").status_code == 400
    # an explicit pipeline the org does not have falls back to the default one
    resp = owner_client.get("/api/v1/dashboard/?pipeline=00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 200 and resp.json()["deals_by_stage"]["pipeline"]["id"] == str(pipeline.pk)


def test_sales_rep_only_counts_records_in_their_scope(org_a, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    outsider = make_member(org_a, "sales_rep")
    _seed(crm, org_a, owner=outsider)  # someone else's records
    crm.make_contact(org_a, owner=rep)
    crm.make_deal(org_a, owner=rep, amount="42.00", amount_base="42.00")
    resp = client_for(rep.user, rep).get("/api/v1/dashboard/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["contacts_created"] == 1
    assert data["open_pipeline"] == {"count": 1, "amount": "42.00"}
    assert data["deals_won"]["count"] == 0
    assert data["top_companies"] == []


def test_numbers_never_cross_tenants(org_a, org_b, owner_client, crm):
    _seed(crm, org_b)
    data = owner_client.get("/api/v1/dashboard/").json()
    assert data["contacts_created"] == 0
    assert data["open_pipeline"] == {"count": 0, "amount": "0.00"}
    assert data["top_companies"] == []
    assert all(s["count"] == 0 for s in data["deals_by_stage"]["stages"])


def test_widgets_are_null_without_the_module_permission(org_a, crm):
    _seed(crm, org_a)
    membership = org_a.owner_membership
    limited = Actor(
        user=org_a.owner,
        membership=membership,
        organization=org_a.org,
        role_key="custom",
        grants=MappingProxyType({"dashboards.view": "all"}),
    )
    with tenant_context(org_a.org.pk, user_id=org_a.owner.pk, membership_id=membership.pk, reason="test.dashboard"):
        data = service.summary(limited)
    assert data["contacts_created"] is None
    assert data["deals_won"] is None and data["open_pipeline"] is None
    assert data["deals_by_stage"] is None and data["revenue_trend"] is None and data["top_companies"] is None


def test_dashboard_requires_session_and_organization(anon_client, make_user, client_for):
    assert anon_client.get("/api/v1/dashboard/").status_code in (401, 403)
    assert client_for(make_user()).get("/api/v1/dashboard/").status_code == 403
