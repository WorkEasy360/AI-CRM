"""Helpdesk second pass: categories and products, SLA and overdue, the ticket thread, merge and activity."""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.core.tenancy.context import tenant_context
from apps.helpdesk.models import Ticket
from tests.factories import make_ticket

pytestmark = pytest.mark.django_db


def _create(client, **body):
    body.setdefault("subject", "WhatsApp API not working")
    return client.post("/api/v1/tickets/", body, format="json")


def _age(bundle, ticket_id, hours):
    with tenant_context(bundle.org.pk):
        Ticket.objects.filter(pk=ticket_id).update(created_at=timezone.now() - dt.timedelta(hours=hours))


def test_category_product_and_search_by_number(org_a, org_b, owner_client, crm):
    contact = crm.make_contact(org_a, first_name="Rahul", last_name="Sharma")
    with tenant_context(org_a.org.pk):
        from apps.products.models import Product

        product = Product.objects.create(name="WorkEasy360 CRM", currency="INR")
    resp = _create(owner_client, category="technical", product_id=str(product.pk), contact_id=str(contact.pk))
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["category"] == "technical" and body["product"]["name"] == "WorkEasy360 CRM"
    assert body["due_at"] and body["is_overdue"] is False
    _create(owner_client, subject="Invoice copy required", category="billing")

    listed = owner_client.get("/api/v1/tickets/", {"category": "technical"}).json()["results"]
    assert [t["id"] for t in listed] == [body["id"]]
    assert [t["id"] for t in owner_client.get("/api/v1/tickets/", {"product": str(product.pk)}).json()["results"]] == [
        body["id"]
    ]
    for q in ("#TK-1001", "tk1001", "1001"):
        assert [t["id"] for t in owner_client.get("/api/v1/tickets/", {"q": q}).json()["results"]] == [body["id"]]
    assert owner_client.get("/api/v1/tickets/", {"category": "nope"}).status_code == 400

    # a product from another organization does not validate
    with tenant_context(org_b.org.pk):
        from apps.products.models import Product

        foreign = Product.objects.create(name="Elsewhere", currency="INR")
    assert _create(owner_client, product_id=str(foreign.pk)).status_code == 400


def test_sla_drives_overdue_and_only_admins_change_it(org_a, owner_client, client_for, make_member):
    urgent = _create(owner_client, priority="urgent").json()
    low = _create(owner_client, priority="low").json()
    _age(org_a, urgent["id"], 5)  # urgent SLA 4h: overdue
    _age(org_a, low["id"], 5)  # low SLA 72h: on time
    overdue = owner_client.get("/api/v1/tickets/", {"overdue": "1"}).json()["results"]
    assert [t["id"] for t in overdue] == [urgent["id"]] and overdue[0]["is_overdue"] is True
    assert owner_client.get("/api/v1/tickets/summary/").json()["overdue"] == 1

    # resolved tickets are never overdue
    owner_client.patch(f"/api/v1/tickets/{urgent['id']}/", {"status": "resolved", "version": 1}, format="json")
    assert owner_client.get("/api/v1/tickets/summary/").json()["overdue"] == 0

    # tightening the low SLA to 2h makes the low ticket overdue at once
    rep = make_member(org_a, "sales_rep")
    assert client_for(rep.user, rep).put("/api/v1/tickets/sla/", {"low": 2}, format="json").status_code == 403
    assert owner_client.put("/api/v1/tickets/sla/", {"low": 0}, format="json").status_code == 400
    resp = owner_client.put("/api/v1/tickets/sla/", {"low": 2}, format="json")
    assert resp.status_code == 200 and resp.json()["low"] == 2 and resp.json()["urgent"] == 4
    assert owner_client.get("/api/v1/tickets/sla/").json()["low"] == 2
    assert [t["id"] for t in owner_client.get("/api/v1/tickets/", {"overdue": "1"}).json()["results"]] == [low["id"]]


def test_thread_replies_notes_and_who_may_post(org_a, org_b, owner_client, client_for, make_member):
    ticket = _create(owner_client).json()
    url = f"/api/v1/tickets/{ticket['id']}/messages/"
    assert owner_client.post(url, {"kind": "customer", "body": "Still failing."}, format="json").status_code == 201
    assert (
        owner_client.post(url, {"kind": "note", "body": "Token expired on their side."}, format="json").status_code
        == 201
    )
    resp = owner_client.post(url, {"kind": "reply", "body": "We are checking this issue."}, format="json")
    assert resp.status_code == 201 and resp.json()["author"]["id"] == str(org_a.owner_membership.pk)
    # the first reply picks the ticket up
    assert owner_client.get(f"/api/v1/tickets/{ticket['id']}/").json()["status"] == "in_progress"

    thread = owner_client.get(url).json()["results"]
    assert [m["kind"] for m in thread] == ["customer", "note", "reply"]
    assert owner_client.post(url, {"kind": "note", "body": "   "}, format="json").status_code == 400
    assert owner_client.post(url, {"kind": "note", "body": "x", "send_via": "email"}, format="json").status_code == 400
    # sending needs a linked contact
    assert owner_client.post(url, {"body": "Hi", "send_via": "email"}, format="json").status_code == 400

    # a viewer reads the thread but cannot post; another organization sees nothing
    viewer = make_member(org_a, "viewer")
    viewer_client = client_for(viewer.user, viewer)
    assert len(viewer_client.get(url).json()["results"]) == 3
    assert viewer_client.post(url, {"kind": "note", "body": "hi"}, format="json").status_code == 403
    other = client_for(org_b.owner, org_b.owner_membership)
    assert other.get(url).status_code == 404
    assert other.post(url, {"kind": "note", "body": "hi"}, format="json").status_code == 404

    activity = owner_client.get(f"/api/v1/tickets/{ticket['id']}/activity/").json()["results"]
    labels = [a["label"] for a in activity]
    assert "created the ticket" in labels and "added an internal note" in labels and "replied" in labels
    assert all(set(a) == {"id", "action", "label", "actor", "created_at"} for a in activity)


def test_merge_moves_the_thread_and_closes_the_source(org_a, org_b, owner_client, client_for, make_member):
    target = _create(owner_client, subject="WhatsApp API not working").json()
    source = _create(owner_client, subject="WhatsApp down again", description="Same issue.").json()
    owner_client.post(
        f"/api/v1/tickets/{source['id']}/messages/", {"kind": "customer", "body": "Any update?"}, format="json"
    )

    assert (
        owner_client.post(f"/api/v1/tickets/{source['id']}/merge/", {"into": source["id"]}, format="json").status_code
        == 400
    )
    foreign = make_ticket(org_b)
    assert (
        owner_client.post(
            f"/api/v1/tickets/{source['id']}/merge/", {"into": str(foreign.pk)}, format="json"
        ).status_code
        == 400
    )
    resp = owner_client.post(f"/api/v1/tickets/{source['id']}/merge/", {"into": target["id"]}, format="json")
    assert resp.status_code == 200, resp.content
    assert owner_client.get(f"/api/v1/tickets/{source['id']}/").json()["status"] == "closed"
    bodies = [m["body"] for m in owner_client.get(f"/api/v1/tickets/{target['id']}/messages/").json()["results"]]
    assert "Any update?" in bodies and any(b.startswith("Merged from #TK-1002") for b in bodies)

    # a rep cannot merge tickets they may not update
    rep = make_member(org_a, "sales_rep")
    assert client_for(rep.user, rep).post(
        f"/api/v1/tickets/{target['id']}/merge/", {"into": source["id"]}, format="json"
    ).status_code in (403, 404)


def test_ticket_attachments_follow_ticket_visibility(org_a, org_b, owner_client, client_for):
    from django.core.files.uploadedfile import SimpleUploadedFile

    ticket = _create(owner_client).json()
    upload = SimpleUploadedFile("log.txt", b"error 500", content_type="text/plain")
    resp = owner_client.post(
        "/api/v1/files/", {"entity_type": "ticket", "entity_id": ticket["id"], "file": upload}, format="multipart"
    )
    assert resp.status_code == 201, resp.content
    other = client_for(org_b.owner, org_b.owner_membership)
    assert other.get("/api/v1/files/", {"entity_type": "ticket", "entity_id": ticket["id"]}).status_code == 404
