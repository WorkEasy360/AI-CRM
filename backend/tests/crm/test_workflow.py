"""Critical business workflow (Phase 2 slice): organization → invite → company → contact → deal →
product → stage moves → won, verified through the API with two users, then the timeline reflects it."""

from __future__ import annotations

import pytest

from apps.audit.models import AuditEvent
from apps.core.tenancy.context import tenant_context

pytestmark = pytest.mark.django_db


def test_end_to_end_sales_workflow(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    repc = client_for(rep.user, rep)

    company = owner_client.post(
        "/api/v1/companies/", {"name": "Globex", "website": "globex.example", "industry": "Energy"}, format="json"
    ).json()
    contact = repc.post(
        "/api/v1/contacts/",
        {"first_name": "Hank", "last_name": "Scorpio", "email": "hank@globex.example", "company_id": company["id"]},
        format="json",
    ).json()
    assert contact["owner"]["id"] == str(rep.pk)
    product = owner_client.post(
        "/api/v1/products/", {"name": "Reactor", "sku": "RX-1", "unit_price": "5000", "tax_rate": "18"}, format="json"
    ).json()

    pipeline = owner_client.get("/api/v1/pipelines/").json()["results"][0]
    stages = {s["name"]: s for s in pipeline["stages"]}
    deal = repc.post(
        "/api/v1/deals/",
        {
            "name": "Globex reactor",
            "company_id": company["id"],
            "primary_contact_id": contact["id"],
            "amount": "10000",
            "expected_close_date": "2026-11-30",
        },
        format="json",
    ).json()
    assert deal["stage"]["name"] == "Qualification" and deal["owner"]["id"] == str(rep.pk)

    line = repc.post(
        f"/api/v1/deals/{deal['id']}/products/add/", {"product_id": product["id"], "quantity": "2"}, format="json"
    )
    assert line.status_code == 201 and line.json()["line_total"] == "10000.00"

    version = deal["version"]
    for name in ["Needs analysis", "Proposal", "Negotiation", "Closed won"]:
        resp = repc.post(
            f"/api/v1/deals/{deal['id']}/stage/", {"stage_id": stages[name]["id"], "version": version}, format="json"
        )
        assert resp.status_code == 200, resp.content
        version = resp.json()["version"]
    final = repc.get(f"/api/v1/deals/{deal['id']}/").json()
    assert final["status"] == "won" and final["probability"] == 100 and final["closed_at"]

    history = repc.get(f"/api/v1/deals/{deal['id']}/history/").json()["results"]
    assert [h["to_stage"]["name"] for h in reversed(history)] == [
        "Qualification",
        "Needs analysis",
        "Proposal",
        "Negotiation",
        "Closed won",
    ]

    repc.post("/api/v1/notes/", {"entity_type": "deal", "entity_id": deal["id"], "body": "Signed!"}, format="json")
    timeline = repc.get(f"/api/v1/timeline/?entity_type=deal&entity_id={deal['id']}").json()["results"]
    assert timeline[0]["kind"] == "note" and timeline[1]["kind"] == "deal.stage_changed"

    # the company/contact pages see the won deal; KPIs reflect it
    assert owner_client.get("/api/v1/companies/stats/").json()["with_won_deals"] == 1
    company_timeline = owner_client.get(f"/api/v1/timeline/?entity_type=company&entity_id={company['id']}").json()[
        "results"
    ]
    assert any(e["kind"] == "deal.linked" and e["data"]["status"] == "won" for e in company_timeline)
    board = owner_client.get("/api/v1/deals/board/").json()
    won_col = next(s for s in board["stages"] if s["kind"] == "won")
    assert won_col["deal_count"] == 1 and won_col["total_amount_base"] == "10000.00"

    with tenant_context(org_a.org.pk):
        actions = set(AuditEvent.objects.values_list("action", flat=True))
    assert {
        "companies.created",
        "contacts.created",
        "products.created",
        "deals.created",
        "deals.product_added",
        "deals.stage_changed",
        "notes.created",
    } <= actions
