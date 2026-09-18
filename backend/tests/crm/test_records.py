"""Contacts, companies, products: CRUD, validation, filters/sort, concurrency, archive, tags, bulk."""

from __future__ import annotations

import pytest

from apps.audit.models import AuditEvent
from apps.core.tenancy.context import tenant_context

pytestmark = pytest.mark.django_db


def _events(bundle, action):
    with tenant_context(bundle.org.pk):
        return list(AuditEvent.objects.filter(action=action))


def test_contact_crud_and_audit(org_a, owner_client, crm):
    company = crm.make_company(org_a, name="Acme")
    resp = owner_client.post(
        "/api/v1/contacts/",
        {
            "first_name": "Grace",
            "last_name": "Hopper",
            "email": "Grace@Example.com",
            "company_id": str(company.pk),
            "phone": "+91 98765 43210",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["email"] == "grace@example.com"
    assert body["company"] == {"id": str(company.pk), "name": "Acme"}
    assert body["owner"]["id"] == str(org_a.owner_membership.pk)
    assert body["version"] == 1
    assert _events(org_a, "contacts.created")

    resp = owner_client.patch(
        f"/api/v1/contacts/{body['id']}/", {"job_title": "Rear Admiral", "version": 1}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["job_title"] == "Rear Admiral"
    assert resp.json()["version"] == 2
    assert _events(org_a, "contacts.updated")

    # stale version → 409, If-Match header also accepted
    resp = owner_client.patch(f"/api/v1/contacts/{body['id']}/", {"job_title": "x", "version": 1}, format="json")
    assert resp.status_code == 409
    assert resp.json()["type"] == "version_conflict"
    resp = owner_client.patch(f"/api/v1/contacts/{body['id']}/", {"job_title": "y"}, format="json", HTTP_IF_MATCH='"2"')
    assert resp.status_code == 200
    # missing version → 428
    resp = owner_client.patch(f"/api/v1/contacts/{body['id']}/", {"job_title": "z"}, format="json")
    assert resp.status_code == 428

    resp = owner_client.get(f"/api/v1/contacts/{body['id']}/")
    assert resp.status_code == 200
    assert resp.json()["display_name"] == "Grace Hopper"

    # archive (soft delete), hidden from list, visible with ?archived=true, restorable
    assert owner_client.delete(f"/api/v1/contacts/{body['id']}/").status_code == 204
    assert _events(org_a, "contacts.archived")
    ids = {c["id"] for c in owner_client.get("/api/v1/contacts/").json()["results"]}
    assert body["id"] not in ids
    ids = {c["id"] for c in owner_client.get("/api/v1/contacts/?archived=true").json()["results"]}
    assert body["id"] in ids
    resp = owner_client.patch(f"/api/v1/contacts/{body['id']}/", {"job_title": "no", "version": 3}, format="json")
    assert resp.status_code == 409  # archived records are read-only
    assert owner_client.post(f"/api/v1/contacts/{body['id']}/restore/").status_code == 200
    assert _events(org_a, "contacts.restored")


def test_contact_validation(org_a, owner_client):
    resp = owner_client.post("/api/v1/contacts/", {"email": "not-an-email"}, format="json")
    assert resp.status_code == 400
    assert {e["field"] for e in resp.json()["errors"]} == {"email"}
    resp = owner_client.post("/api/v1/contacts/", {"phone": "+1 555"}, format="json")
    assert resp.status_code == 400  # needs a name or email
    resp = owner_client.post("/api/v1/contacts/", {"first_name": "A", "phone": "call me maybe"}, format="json")
    assert resp.status_code == 400
    resp = owner_client.post(
        "/api/v1/contacts/", {"first_name": "A", "address": {"line1": "x", "evil": "y"}}, format="json"
    )
    assert resp.status_code == 400
    resp = owner_client.post("/api/v1/contacts/", {"first_name": "A" * 81}, format="json")
    assert resp.status_code == 400
    # NUL bytes are refused outright by DRF; other control characters are stripped
    assert (
        owner_client.post("/api/v1/contacts/", {"first_name": "Ctrl" + chr(0) + "Char"}, format="json").status_code
        == 400
    )
    resp = owner_client.post("/api/v1/contacts/", {"first_name": "Ctrl\x07Char\x1b[31m"}, format="json")
    assert resp.status_code == 201
    assert resp.json()["first_name"] == "CtrlChar[31m"


def test_company_validation_rejects_dangerous_urls(org_a, owner_client):
    for bad in ["javascript:alert(1)", "ftp://x", "http://user:pw@host", "http://"]:
        resp = owner_client.post("/api/v1/companies/", {"name": "X", "website": bad}, format="json")
        assert resp.status_code == 400, bad
    resp = owner_client.post("/api/v1/companies/", {"name": "X", "website": "example.com/path"}, format="json")
    assert resp.status_code == 201
    assert resp.json()["website"] == "https://example.com/path"
    resp = owner_client.post("/api/v1/companies/", {"name": "Y", "company_size": "huge"}, format="json")
    assert resp.status_code == 400
    resp = owner_client.post("/api/v1/companies/", {"name": "Y", "annual_revenue": "-5"}, format="json")
    assert resp.status_code == 400


def test_products(org_a, owner_client, crm):
    resp = owner_client.post(
        "/api/v1/products/", {"name": "Widget", "sku": "W-1", "unit_price": "12.50", "tax_rate": "18"}, format="json"
    )
    assert resp.status_code == 201, resp.content
    assert resp.json()["currency"] == org_a.org.base_currency
    resp = owner_client.post("/api/v1/products/", {"name": "Dup", "sku": "W-1"}, format="json")
    assert resp.status_code == 409
    resp = owner_client.post("/api/v1/products/", {"name": "Bad", "sku": "W 1;drop"}, format="json")
    assert resp.status_code == 400
    resp = owner_client.post("/api/v1/products/", {"name": "Bad", "tax_rate": "101"}, format="json")
    assert resp.status_code == 400
    # products have no bulk endpoint
    assert owner_client.post("/api/v1/products/bulk/", {"ids": [], "action": "archive"}, format="json").status_code in (
        403,
        405,
    )


def test_list_filters_sort_and_count(org_a, owner_client, crm, make_member):
    other = make_member(org_a, "sales_rep")
    company = crm.make_company(org_a)
    crm.make_contact(org_a, first_name="Zed", last_name="A", company=company)
    crm.make_contact(org_a, first_name="Amy", last_name="B", owner=other, source="web")
    crm.make_contact(org_a, first_name="Bob", last_name="C", email="bob@corp.io")

    resp = owner_client.get("/api/v1/contacts/?sort=first_name")
    assert [c["first_name"] for c in resp.json()["results"]] == ["Amy", "Bob", "Zed"]
    resp = owner_client.get("/api/v1/contacts/?sort=-first_name&limit=2")
    assert [c["first_name"] for c in resp.json()["results"]] == ["Zed", "Bob"]
    assert resp.json()["next"]
    resp = owner_client.get("/api/v1/contacts/?owner=me")
    assert len(resp.json()["results"]) == 2
    resp = owner_client.get(f"/api/v1/contacts/?owner={other.pk}")
    assert [c["first_name"] for c in resp.json()["results"]] == ["Amy"]
    resp = owner_client.get(f"/api/v1/contacts/?company={company.pk}")
    assert [c["first_name"] for c in resp.json()["results"]] == ["Zed"]
    resp = owner_client.get("/api/v1/contacts/?has_company=true")
    assert [c["first_name"] for c in resp.json()["results"]] == ["Zed"]
    resp = owner_client.get("/api/v1/contacts/?q=corp")
    assert [c["first_name"] for c in resp.json()["results"]] == ["Bob"]
    resp = owner_client.get("/api/v1/contacts/count/?source=web")
    assert resp.json() == {"count": 1, "exact": True}
    resp = owner_client.get("/api/v1/contacts/stats/")
    assert resp.json()["total"] == 3

    # unknown filters, sorts and malformed values are rejected, never ignored
    assert owner_client.get("/api/v1/contacts/?password=x").status_code == 400
    assert owner_client.get("/api/v1/contacts/?sort=owner__user__password").status_code == 400
    assert owner_client.get("/api/v1/contacts/?sort=name;drop table").status_code == 400
    assert owner_client.get("/api/v1/contacts/?company=not-a-uuid").status_code == 400
    assert owner_client.get("/api/v1/contacts/?created_from=yesterday").status_code == 400
    assert owner_client.get("/api/v1/contacts/?q=" + "x" * 300).status_code == 400
    assert owner_client.get("/api/v1/contacts/?limit=100000").status_code == 200
    assert len(owner_client.get("/api/v1/contacts/?limit=100000").json()["results"]) <= 200


def test_tags_on_records(org_a, org_b, owner_client, crm):
    contact = crm.make_contact(org_a)
    tag = crm.make_tag(org_a, "vip")
    foreign = crm.make_tag(org_b, "foreign")
    resp = owner_client.put(f"/api/v1/contacts/{contact.pk}/tags/", {"tag_ids": [str(tag.pk)]}, format="json")
    assert resp.status_code == 200, resp.content
    assert [t["name"] for t in resp.json()["tags"]] == ["vip"]
    resp = owner_client.get(f"/api/v1/contacts/{contact.pk}/")
    assert [t["name"] for t in resp.json()["tags"]] == ["vip"]
    resp = owner_client.put(f"/api/v1/contacts/{contact.pk}/tags/", {"tag_ids": [str(foreign.pk)]}, format="json")
    assert resp.status_code == 400
    resp = owner_client.put(f"/api/v1/contacts/{contact.pk}/tags/", {"tag_ids": []}, format="json")
    assert resp.json()["tags"] == []
    # tag management API
    resp = owner_client.post("/api/v1/tags/", {"name": "VIP", "color_token": "teal"}, format="json")
    assert resp.status_code == 409  # case-insensitive duplicate
    resp = owner_client.post("/api/v1/tags/", {"name": "hot", "color_token": "neon"}, format="json")
    assert resp.status_code == 400


def test_bulk_changes_bump_the_version_so_stale_edits_conflict(org_a, owner_client, crm, make_member):
    rep = make_member(org_a, "sales_rep")
    contact = crm.make_contact(org_a, owner=org_a.owner_membership)
    stale = owner_client.get(f"/api/v1/contacts/{contact.pk}/").json()["version"]
    resp = owner_client.post(
        "/api/v1/contacts/bulk/",
        {"ids": [str(contact.pk)], "action": "reassign", "payload": {"owner_id": str(rep.pk)}},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert owner_client.get(f"/api/v1/contacts/{contact.pk}/").json()["version"] == stale + 1
    # A client that loaded the record before the bulk reassignment must not silently overwrite it.
    resp = owner_client.patch(f"/api/v1/contacts/{contact.pk}/", {"job_title": "x", "version": stale}, format="json")
    assert resp.status_code == 409 and resp.json()["type"] == "version_conflict"


def test_bulk_actions_refuse_out_of_scope(org_a, owner_client, crm, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    manager = make_member(org_a, "sales_manager")
    mine = crm.make_contact(org_a, owner=manager)
    theirs = crm.make_contact(org_a, owner=rep)
    tag = crm.make_tag(org_a)
    mgr = client_for(manager.user, manager)
    resp = mgr.post(
        "/api/v1/contacts/bulk/",
        {"ids": [str(mine.pk), str(theirs.pk)], "action": "add_tag", "payload": {"tag_id": str(tag.pk)}},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["affected"] == 2
    resp = mgr.post(
        "/api/v1/contacts/bulk/",
        {"ids": [str(mine.pk)], "action": "reassign", "payload": {"owner_id": str(rep.pk)}},
        format="json",
    )
    assert resp.status_code == 200
    resp = mgr.post(
        "/api/v1/contacts/bulk/", {"ids": [str(mine.pk), str(theirs.pk)], "action": "archive"}, format="json"
    )
    assert resp.status_code == 200
    assert _events(org_a, "contacts.bulk_archive")
    # reps have no bulk_update permission
    repc = client_for(rep.user, rep)
    assert (
        repc.post("/api/v1/contacts/bulk/", {"ids": [str(theirs.pk)], "action": "archive"}, format="json").status_code
        == 403
    )
    # unknown id (or id outside scope) → the whole request is refused
    resp = mgr.post(
        "/api/v1/contacts/bulk/",
        {"ids": [str(mine.pk), "00000000-0000-0000-0000-000000000001"], "action": "restore"},
        format="json",
    )
    assert resp.status_code == 400
    assert resp.json()["type"] == "bulk_out_of_scope"
    resp = mgr.post("/api/v1/contacts/bulk/", {"ids": [str(mine.pk)], "action": "drop"}, format="json")
    assert resp.status_code == 400


def test_deal_exposes_primary_contact_phone_only_within_contact_scope(
    org_a, owner_client, crm, make_member, client_for
):
    """The deal header WhatsApp action needs the primary contact's phone. It rides along on the joined
    contact row (nothing is copied onto the deal) and is null when the caller may not view the contact."""
    rep = make_member(org_a, "sales_rep")
    other = make_member(org_a, "sales_rep")
    mine = crm.make_contact(org_a, owner=rep, phone="+1 555 0100 111", whatsapp_opt_in=True)
    theirs = crm.make_contact(org_a, owner=other, phone="+1 555 0100 222")
    own_deal = crm.make_deal(org_a, owner=rep, contact=mine)
    foreign_contact_deal = crm.make_deal(org_a, owner=rep, contact=theirs)
    repc = client_for(rep.user, rep)

    body = repc.get(f"/api/v1/deals/{own_deal.pk}/").json()["primary_contact"]
    assert body["phone"] == "+1 555 0100 111" and body["whatsapp_opt_in"] is True

    body = repc.get(f"/api/v1/deals/{foreign_contact_deal.pk}/").json()["primary_contact"]
    assert body["name"] and body["phone"] is None and body["whatsapp_opt_in"] is None
    listed = {d["id"]: d for d in repc.get("/api/v1/deals/").json()["results"]}
    assert listed[str(foreign_contact_deal.pk)]["primary_contact"]["phone"] is None
    assert listed[str(own_deal.pk)]["primary_contact"]["phone"] == "+1 555 0100 111"

    # The owner (contacts.view: all) sees both on the record itself.
    assert (
        owner_client.get(f"/api/v1/deals/{foreign_contact_deal.pk}/").json()["primary_contact"]["phone"]
        == "+1 555 0100 222"
    )
    # The board goes further than scoping and omits the contact's phone entirely: a Kanban card shows
    # a name, so the card carries a name. Nothing weaker than the rule above - strictly less.
    board = owner_client.get("/api/v1/deals/board/").json()
    cards = {d["id"]: d for s in board["stages"] for d in s["deals"]}
    card_contact = cards[str(foreign_contact_deal.pk)]["primary_contact"]
    assert card_contact["name"] and set(card_contact) == {"id", "name"}
