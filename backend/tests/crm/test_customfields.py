"""Custom fields: definitions are admin-managed; values are validated against them and cannot bypass anything."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.django_db


def _define(client, **kwargs):
    payload = {
        "entity_type": "contact",
        "key": "priority",
        "label": "Priority",
        "field_type": "dropdown",
        "options": ["low", "high"],
    }
    payload.update(kwargs)
    return client.post("/api/v1/custom-fields/", payload, format="json")


def test_definition_management_and_permissions(org_a, owner_client, make_member, client_for):
    resp = _define(owner_client)
    assert resp.status_code == 201, resp.content
    fid = resp.json()["id"]
    assert _define(owner_client).status_code == 409  # duplicate key
    for bad_key in ["Priority", "1abc", "a-b", "id", "owner_id", "email", "organization", "x" * 41, "custom_data"]:
        assert _define(owner_client, key=bad_key, label="x").status_code in (400, 409), bad_key
    assert _define(owner_client, key="ok", field_type="nope").status_code == 400
    assert (
        _define(owner_client, key="ok", field_type="text", options=["a"]).status_code == 400
    )  # options only for choice types
    assert _define(owner_client, key="ok2", field_type="dropdown", options=[]).status_code == 400
    assert _define(owner_client, key="ok3", field_type="dropdown", options=["a", "a"]).status_code == 400
    # key/type immutable; label editable
    resp = owner_client.patch(
        f"/api/v1/custom-fields/{fid}/", {"label": "Prio", "key": "hacked", "field_type": "text"}, format="json"
    )
    assert resp.status_code == 200 and resp.json()["key"] == "priority" and resp.json()["field_type"] == "dropdown"
    # non-admins can read but not manage
    rep = make_member(org_a, "sales_rep")
    repc = client_for(rep.user, rep)
    assert repc.get("/api/v1/custom-fields/?entity_type=contact").status_code == 200
    assert _define(repc, key="rep_field").status_code == 403
    assert repc.patch(f"/api/v1/custom-fields/{fid}/", {"label": "x"}, format="json").status_code == 403
    assert repc.delete(f"/api/v1/custom-fields/{fid}/").status_code == 403
    manager = make_member(org_a, "sales_manager")
    assert _define(client_for(manager.user, manager), key="mgr_field").status_code == 403
    # archive hides the definition and its values
    assert owner_client.delete(f"/api/v1/custom-fields/{fid}/").status_code == 204
    assert all(d["id"] != fid for d in owner_client.get("/api/v1/custom-fields/").json()["results"])
    assert owner_client.get("/api/v1/custom-fields/?archived=true").json()["results"][0]["id"] == fid


def test_values_validated_by_type(org_a, owner_client, crm):
    crm.make_custom_field(
        org_a, "contact", "priority", field_type="dropdown", options=["low", "high"], label="Priority"
    )
    crm.make_custom_field(org_a, "contact", "budget", field_type="currency", label="Budget")
    crm.make_custom_field(org_a, "contact", "score", field_type="integer", label="Score")
    crm.make_custom_field(org_a, "contact", "signed", field_type="date", label="Signed")
    crm.make_custom_field(org_a, "contact", "site", field_type="url", label="Site")
    crm.make_custom_field(org_a, "contact", "flags", field_type="multi_select", options=["a", "b"], label="Flags")
    crm.make_custom_field(org_a, "contact", "active", field_type="checkbox", label="Active")
    crm.make_custom_field(org_a, "contact", "pct", field_type="percent", label="Pct")

    def create(custom):
        return owner_client.post("/api/v1/contacts/", {"first_name": "T", "custom_data": custom}, format="json")

    good = create(
        {
            "priority": "high",
            "budget": "12.5",
            "score": "7",
            "signed": "2026-01-31",
            "site": "example.org",
            "flags": ["b", "a", "a"],
            "active": "true",
            "pct": 99.5,
        }
    )
    assert good.status_code == 201, good.content
    assert good.json()["custom_data"] == {
        "priority": "high",
        "budget": "12.5",
        "score": 7,
        "signed": "2026-01-31",
        "site": "https://example.org",
        "flags": ["b", "a"],
        "active": True,
        "pct": "99.5",
    }
    for bad in [
        {"priority": "urgent"},
        {"budget": "lots"},
        {"score": 1.5},
        {"score": True},
        {"signed": "31/01/2026"},
        {"site": "javascript:alert(1)"},
        {"flags": ["zzz"]},
        {"flags": "a,b"},
        {"active": "yes please"},
        {"pct": 150},
        {"unknown_field": "x"},
        {"organization_id": "x"},
        "not an object",
        {"priority": {"$gt": ""}},
    ]:
        resp = create(bad)
        assert resp.status_code == 400, bad
        assert all(e["field"].startswith("custom_data") for e in resp.json()["errors"]), resp.content
    # oversized payload
    assert create({"priority": "x" * 70000}).status_code == 400


def test_required_partial_merge_and_clearing(org_a, owner_client, crm):
    crm.make_custom_field(org_a, "company", "region", field_type="text", label="Region", is_required=True)
    crm.make_custom_field(org_a, "company", "tier", field_type="text", label="Tier")
    assert owner_client.post("/api/v1/companies/", {"name": "NoRegion"}, format="json").status_code == 400
    resp = owner_client.post(
        "/api/v1/companies/", {"name": "Ok", "custom_data": {"region": "APAC", "tier": "gold"}}, format="json"
    )
    assert resp.status_code == 201
    cid = resp.json()["id"]
    # partial update merges; null clears; required cannot be cleared
    resp = owner_client.patch(f"/api/v1/companies/{cid}/", {"custom_data": {"tier": None}, "version": 1}, format="json")
    assert resp.status_code == 200 and resp.json()["custom_data"] == {"region": "APAC"}
    resp = owner_client.patch(f"/api/v1/companies/{cid}/", {"custom_data": {"region": ""}, "version": 2}, format="json")
    assert resp.status_code == 400
    # a PATCH without custom_data leaves values untouched
    resp = owner_client.patch(f"/api/v1/companies/{cid}/", {"industry": "SaaS", "version": 2}, format="json")
    assert resp.status_code == 200 and resp.json()["custom_data"] == {"region": "APAC"}


def test_definitions_are_tenant_scoped(org_a, org_b, owner_client, crm):
    crm.make_custom_field(org_b, "contact", "secret", field_type="text", label="Secret")
    resp = owner_client.post("/api/v1/contacts/", {"first_name": "T", "custom_data": {"secret": "x"}}, format="json")
    assert resp.status_code == 400  # org B's definition does not exist for org A
    assert owner_client.get("/api/v1/custom-fields/").json()["results"] == []


def test_custom_field_filters(org_a, owner_client, crm):
    crm.make_custom_field(
        org_a, "contact", "priority", field_type="dropdown", options=["low", "high"], label="Priority"
    )
    crm.make_custom_field(org_a, "contact", "notes_long", field_type="textarea", label="Long")
    crm.make_contact(org_a, first_name="Hi", custom_data={"priority": "high"})
    crm.make_contact(org_a, first_name="Lo", custom_data={"priority": "low"})
    resp = owner_client.get("/api/v1/contacts/?custom.priority=high")
    assert resp.status_code == 200 and [c["first_name"] for c in resp.json()["results"]] == ["Hi"]
    assert owner_client.get("/api/v1/contacts/?custom.priority=urgent").status_code == 400
    assert owner_client.get("/api/v1/contacts/?custom.nope=1").status_code == 400
    assert owner_client.get("/api/v1/contacts/?custom.notes_long=x").status_code == 400  # not filterable
    assert owner_client.get("/api/v1/contacts/?custom.priority__contains=h").status_code == 400
    assert owner_client.get("/api/v1/contacts/?custom.priority')=1").status_code == 400


def test_xss_payloads_in_custom_values_are_stored_as_text(org_a, owner_client, crm):
    crm.make_custom_field(org_a, "deal", "memo", field_type="text", label="Memo")
    payload = "<img src=x onerror=alert(1)>"
    resp = owner_client.post("/api/v1/deals/", {"name": "d", "custom_data": {"memo": payload}}, format="json")
    assert resp.status_code == 201
    assert resp.json()["custom_data"]["memo"] == payload
    assert resp["Content-Type"].startswith("application/json")
