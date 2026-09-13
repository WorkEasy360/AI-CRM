"""Lifecycle stages on contacts and companies: transitions, history, automatic promotion, duplicates."""

from __future__ import annotations

import pytest

from apps.core.tenancy.context import tenant_context
from apps.lifecycle.models import LifecycleHistory

pytestmark = pytest.mark.django_db


def test_contact_lifecycle_transitions_are_historised(org_a, owner_client):
    resp = owner_client.post("/api/v1/contacts/", {"first_name": "Lena", "lifecycle_stage": "prospect"}, format="json")
    assert resp.status_code == 201, resp.content
    contact = resp.json()
    assert contact["lifecycle_stage"] == "prospect"
    resp = owner_client.patch(
        f"/api/v1/contacts/{contact['id']}/",
        {"lifecycle_stage": "qualified", "version": contact["version"]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["lifecycle_stage"] == "qualified" and resp.json()["lifecycle_changed_at"]
    assert resp.json()["version"] == contact["version"] + 1
    assert (
        owner_client.patch(
            f"/api/v1/contacts/{contact['id']}/", {"lifecycle_stage": "vip", "version": 2}, format="json"
        ).status_code
        == 400
    )
    with tenant_context(org_a.org.pk):
        history = list(LifecycleHistory.objects.filter(entity_id=contact["id"]).order_by("changed_at"))
    assert [(h.from_stage, h.to_stage) for h in history] == [("", "prospect"), ("prospect", "qualified")]
    timeline = owner_client.get(f"/api/v1/timeline/?entity_type=contact&entity_id={contact['id']}").json()["results"]
    assert [e["data"]["to_stage"] for e in timeline if e["kind"] == "lifecycle.changed"] == ["qualified", "prospect"]
    # filter + sort
    assert [c["id"] for c in owner_client.get("/api/v1/contacts/?lifecycle=qualified").json()["results"]] == [
        contact["id"]
    ]
    assert owner_client.get("/api/v1/contacts/?lifecycle=nope").status_code == 400


def test_closed_won_promotes_contacts_and_company_to_customer(org_a, owner_client, crm):
    pipeline = crm.make_pipeline(org_a)
    company = crm.make_company(org_a, name="Globex")
    contact = crm.make_contact(org_a, company=company)
    extra = crm.make_contact(org_a, company=company)
    deal = crm.make_deal(org_a, company=company, contact=contact)
    owner_client.post(f"/api/v1/deals/{deal.pk}/contacts/add/", {"contact_id": str(extra.pk)}, format="json")
    won = crm.stage_named(pipeline, "Closed won")
    resp = owner_client.post(f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": str(won.pk), "version": 1}, format="json")
    assert resp.status_code == 200, resp.content
    assert owner_client.get(f"/api/v1/contacts/{contact.pk}/").json()["lifecycle_stage"] == "customer"
    assert owner_client.get(f"/api/v1/contacts/{extra.pk}/").json()["lifecycle_stage"] == "customer"
    assert owner_client.get(f"/api/v1/companies/{company.pk}/").json()["lifecycle_stage"] == "customer"
    with tenant_context(org_a.org.pk):
        rows = LifecycleHistory.objects.filter(to_stage="customer")
        assert rows.count() == 3 and set(rows.values_list("source", flat=True)) == {"automation"}
    # a customer is never demoted by another win, and the probability override flag is reset by the move
    deal_json = owner_client.get(f"/api/v1/deals/{deal.pk}/").json()
    assert deal_json["probability_overridden"] is False and deal_json["weighted_amount_base"] == "1000.00"


def test_probability_override_is_recorded(org_a, owner_client, crm):
    crm.make_pipeline(org_a)
    resp = owner_client.post("/api/v1/deals/", {"name": "d", "amount": "2000", "probability": 40}, format="json")
    assert resp.status_code == 201
    body = resp.json()
    assert body["probability_overridden"] is True and body["weighted_amount_base"] == "800.00"
    resp = owner_client.patch(f"/api/v1/deals/{body['id']}/", {"probability": 10, "version": 1}, format="json")
    assert resp.json()["probability_overridden"] is False  # back to the stage default


def test_duplicate_detection_is_scoped(org_a, org_b, owner_client, crm, make_member, client_for):
    company = crm.make_company(org_a, name="Acme Ltd", website="https://www.acme.com")
    crm.make_contact(org_a, first_name="Grace", last_name="Hopper", email="grace@acme.com", phone="+91 98765 43210")
    crm.make_contact(org_b, first_name="Grace", last_name="Hopper", email="grace@acme.com")
    resp = owner_client.get("/api/v1/contacts/duplicates/?email=GRACE@acme.com")
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1 and results[0]["matched_on"] == ["email"]
    assert owner_client.get("/api/v1/contacts/duplicates/?phone=9876543210").json()["results"][0]["matched_on"] == [
        "phone"
    ]
    assert owner_client.get("/api/v1/contacts/duplicates/?first_name=grace&last_name=hopper").json()["results"][0][
        "matched_on"
    ] == ["name"]
    assert owner_client.get("/api/v1/contacts/duplicates/").json()["results"] == []
    companies = owner_client.get("/api/v1/companies/duplicates/?name=acme ltd&website=acme.com/x").json()["results"]
    assert companies[0]["id"] == str(company.pk) and set(companies[0]["matched_on"]) == {"name", "website"}
    # a rep outside the owner's team sees nothing (no existence leak)
    rep = make_member(org_a, "sales_rep")
    assert client_for(rep.user, rep).get("/api/v1/contacts/duplicates/?email=grace@acme.com").json()["results"] == []
