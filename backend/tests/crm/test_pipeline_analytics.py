"""Pipeline page: deal priority and lead source, product filter, headline KPIs and the Analytics tab."""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.core.tenancy.context import tenant_context
from apps.deals.models import Deal, DealProduct
from tests.factories import make_deal, make_pipeline, make_product, stage_named

pytestmark = pytest.mark.django_db


def test_priority_and_lead_source_are_writable_and_filterable(org_a, owner_client):
    pipeline = make_pipeline(org_a)
    resp = owner_client.post(
        "/api/v1/deals/",
        {
            "name": "CRM for Real Estate",
            "pipeline_id": str(pipeline.pk),
            "priority": "high",
            "lead_source": "facebook_ads",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    deal = resp.json()
    assert deal["priority"] == "high" and deal["lead_source"] == "facebook_ads"
    assert owner_client.post("/api/v1/deals/", {"name": "x", "priority": "extreme"}, format="json").status_code == 400

    make_deal(org_a, name="Other")
    found = owner_client.get("/api/v1/deals/", {"lead_source": "facebook_ads"}).json()["results"]
    assert [d["id"] for d in found] == [deal["id"]]
    assert [d["id"] for d in owner_client.get("/api/v1/deals/", {"priority": "high"}).json()["results"]] == [deal["id"]]
    # board cards carry the priority badge
    board = owner_client.get("/api/v1/deals/board/").json()
    cards = [c for s in board["stages"] for c in s["deals"] if c["id"] == deal["id"]]
    assert cards and cards[0]["priority"] == "high"


def test_product_filter_finds_deals_with_that_product(org_a, owner_client):
    product = make_product(org_a, name="WorkEasy360 CRM")
    other = make_product(org_a, name="WhatsApp API")
    deal = make_deal(org_a, name="Has it")
    make_deal(org_a, name="No lines")
    with tenant_context(org_a.org.pk):
        for p in (product, other):
            DealProduct.objects.create(
                deal=deal, product=p, unit_price="10.00", currency=deal.currency, line_total="10.00"
            )
    found = owner_client.get("/api/v1/deals/", {"product": str(product.pk)}).json()["results"]
    assert [d["id"] for d in found] == [str(deal.pk)]
    assert owner_client.get("/api/v1/deals/", {"product": "nope"}).status_code == 400


def test_pipeline_stats_compare_with_the_previous_period(org_a, owner_client, make_member, client_for):
    pipeline = make_pipeline(org_a)
    won, lost = stage_named(pipeline, "Won"), stage_named(pipeline, "Lost")
    make_deal(org_a, name="Open A", amount_base="100000.00", amount="100000.00")
    make_deal(org_a, name="Open B", amount_base="50000.00", amount="50000.00")
    w = make_deal(org_a, name="Won now", stage=won)
    old_won = make_deal(org_a, name="Won before", stage=won)
    make_deal(org_a, name="Lost now", stage=lost)
    now = timezone.now()
    with tenant_context(org_a.org.pk):
        Deal.objects.filter(pk=w.pk).update(created_at=now - dt.timedelta(days=10))
        Deal.objects.filter(pk=old_won.pk).update(
            created_at=now - dt.timedelta(days=55), closed_at=now - dt.timedelta(days=45)
        )

    stats = owner_client.get("/api/v1/deals/pipeline-stats/").json()
    assert stats["pipeline"]["id"] == str(pipeline.pk)
    assert stats["total_deals"] == 5 and stats["open_deals"] == 2
    assert stats["pipeline_value"] == "150000.00"
    # Discovery is 10%: the weighted forecast
    assert stats["expected_revenue"] == "15000.00"
    assert stats["current"]["won"] == 1 and stats["current"]["lost"] == 1 and stats["current"]["win_rate"] == 50.0
    assert stats["current"]["avg_cycle_days"] == pytest.approx(10, abs=0.2)
    assert stats["previous"]["won"] == 1 and stats["previous"]["avg_cycle_days"] == pytest.approx(10, abs=0.2)

    # a rep sees figures for their own deals only
    rep = make_member(org_a, "sales_rep")
    make_deal(org_a, name="Rep deal", owner=rep, amount_base="7000.00", amount="7000.00")
    mine = client_for(rep.user, rep).get("/api/v1/deals/pipeline-stats/").json()
    assert mine["total_deals"] == 1 and mine["pipeline_value"] == "7000.00"


def test_analytics_tab_and_tenant_isolation(org_a, org_b, owner_client, client_for):
    pipeline = make_pipeline(org_a)
    make_deal(org_a, name="A", lead_source="whatsapp")
    make_deal(org_a, name="B", lead_source="whatsapp", stage=stage_named(pipeline, "Won"))
    make_deal(org_a, name="C", stage=stage_named(pipeline, "Lost"), lost_reason="Budget")
    make_deal(org_b, name="Elsewhere", lead_source="website")

    data = owner_client.get("/api/v1/deals/analytics/").json()
    names = [s["name"] for s in data["conversion"]]
    assert names[:2] == ["Discovery", "Fit confirmed"]
    by_name = {s["name"]: s for s in data["conversion"]}
    assert by_name["Discovery"]["reached"] == 1 and by_name["Won"]["reached"] == 1
    assert data["win_loss"]["won"] == 1 and data["win_loss"]["lost"] == 1 and data["win_loss"]["win_rate"] == 50.0
    assert data["win_loss"]["lost_reasons"] == [{"reason": "Budget", "count": 1}]
    sources = {s["source"]: s for s in data["sources"]}
    assert sources["whatsapp"]["count"] == 2 and sources["whatsapp"]["won"] == 1
    assert "website" not in sources  # another organization's deal
    assert data["owners"][0]["deals"] == 3

    other = client_for(org_b.owner, org_b.owner_membership)
    assert other.get(f"/api/v1/deals/analytics/?pipeline={pipeline.pk}").status_code == 404
