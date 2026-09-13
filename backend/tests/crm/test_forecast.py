"""Forecast: weighted pipeline inside the caller's scope, period bounds, breakdowns, dashboard extras."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.core.tenancy.context import tenant_context
from apps.deals.models import Deal
from tests.factories import stage_named

pytestmark = pytest.mark.django_db


def _seed(crm, org, owner=None):
    pipeline = crm.make_pipeline(org)
    today = timezone.now().date()
    open_a = crm.make_deal(org, owner=owner, amount="1000.00", amount_base="1000.00", expected_close_date=today)
    open_b = crm.make_deal(
        org,
        owner=owner,
        stage=stage_named(pipeline, "Negotiation"),
        amount="2000.00",
        amount_base="2000.00",
        expected_close_date=today,
    )
    crm.make_deal(org, owner=owner, amount="999.00", amount_base="999.00")  # no close date: coverage only
    won = crm.make_deal(
        org, owner=owner, stage=stage_named(pipeline, "Closed won"), amount="500.00", amount_base="500.00"
    )
    return pipeline, open_a, open_b, won


def test_forecast_totals_and_breakdown(org_a, owner_client, crm):
    _seed(crm, org_a)
    resp = owner_client.get("/api/v1/forecast/?period=month")
    assert resp.status_code == 200, resp.content
    data = resp.json()
    totals = data["totals"]
    assert totals["pipeline"] == {"count": 2, "amount": "3000.00"}
    # Qualification 10% of 1000 + Negotiation 75% of 2000
    assert totals["weighted"]["amount"] == "1600.00"
    assert totals["committed"] == {"count": 1, "amount": "2000.00"}
    assert totals["won"] == {"count": 1, "amount": "500.00"}
    assert totals["expected_revenue"] == "2100.00"
    assert data["coverage"]["without_close_date"] == 1 and data["coverage"]["open_deals"] == 3
    assert {row["label"] for row in data["breakdown"]} >= {"Qualification", "Negotiation"}
    assert len(data["series"]) >= 1 and data["series"][0]["weighted"] == "1600.00"
    owners = owner_client.get("/api/v1/forecast/?group_by=owner").json()["breakdown"]
    assert owners[0]["weighted"] == "1600.00"
    assert owner_client.get("/api/v1/forecast/?group_by=team").status_code == 200
    assert owner_client.get("/api/v1/forecast/?period=custom&from=2026-01-01&to=2026-01-31").status_code == 200
    assert owner_client.get("/api/v1/forecast/?period=custom&from=2026-01-01&to=2027-06-01").status_code == 400
    assert owner_client.get("/api/v1/forecast/?group_by=owner__user__password").status_code == 400
    assert owner_client.get("/api/v1/forecast/?period=quarter").json()["period"] == "quarter"


def test_forecast_respects_scope_and_tenant(org_a, org_b, crm, make_member, client_for):
    manager = make_member(org_a, "sales_manager")
    rep = make_member(org_a, "sales_rep")
    _seed(crm, org_a, owner=manager)
    _seed(crm, org_b)
    today = timezone.now().date()
    crm.make_deal(org_a, owner=rep, amount="100.00", amount_base="100.00", expected_close_date=today)
    repc = client_for(rep.user, rep)
    data = repc.get("/api/v1/forecast/").json()
    assert data["totals"]["pipeline"] == {"count": 1, "amount": "100.00"}
    mgr = client_for(manager.user, manager).get("/api/v1/forecast/").json()
    assert mgr["totals"]["pipeline"]["count"] == 3
    with tenant_context(org_b.org.pk):
        assert Deal.objects.count() == 4  # untouched by org A queries


def test_dashboard_has_weighted_pipeline_owner_breakdown_and_forecast(org_a, owner_client, crm):
    _seed(crm, org_a)
    data = owner_client.get("/api/v1/dashboard/").json()
    assert data["weighted_pipeline"]["amount"] == "1699.90"  # 10% of 999 joins the no-close-date deal
    assert data["deals_by_owner"][0]["count"] == 3
    assert len(data["forecast"]) == 3 and data["forecast"][0]["weighted"] == "1600.00"
    assert data["win_rate"] == 100 and data["average_deal_size"] == "500.00"
    assert data["lead_conversion"]["created"] == 0
    assert data["activities"]["tasks_due"] == 0
    resp = owner_client.post(
        "/api/v1/activities/",
        {"kind": "task", "title": "Due", "start_at": (timezone.now() - timedelta(hours=1)).isoformat()},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert owner_client.get("/api/v1/dashboard/").json()["activities"]["tasks_overdue"] == 1
