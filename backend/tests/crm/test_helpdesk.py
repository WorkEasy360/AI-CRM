"""Helpdesk tickets: CRUD, numbering, scopes on the assignee, tenant isolation, validation, audit."""

from __future__ import annotations

import pytest

from apps.audit.models import AuditEvent
from apps.core.tenancy.context import tenant_context

pytestmark = pytest.mark.django_db


def _events(bundle, action):
    with tenant_context(bundle.org.pk):
        return list(AuditEvent.objects.filter(action=action))


def _create(client, **body):
    body.setdefault("subject", "WhatsApp API not working")
    return client.post("/api/v1/tickets/", body, format="json")


def test_ticket_crud_numbering_and_audit(org_a, owner_client, crm):
    contact = crm.make_contact(org_a, first_name="Rahul", last_name="Sharma")
    resp = _create(owner_client, priority="high", contact_id=str(contact.pk), description="Messages fail.\nSince today.")
    assert resp.status_code == 201, resp.content
    first = resp.json()
    assert first["number"] == 1001
    assert first["status"] == "open"
    assert first["priority"] == "high"
    assert first["requester"] == "Rahul Sharma"
    assert first["owner"]["id"] == str(org_a.owner_membership.pk)
    assert _events(org_a, "tickets.created")

    second = _create(owner_client, subject="Need onboarding support", requester_name="Priya Verma").json()
    assert second["number"] == 1002
    assert second["requester"] == "Priya Verma"

    resp = owner_client.patch(f"/api/v1/tickets/{first['id']}/", {"status": "resolved", "rating": 5, "version": 1}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["status"] == "resolved"
    assert resp.json()["resolved_at"] is not None
    assert resp.json()["rating"] == 5
    assert _events(org_a, "tickets.updated")

    # stale version answers 409, not a silent overwrite
    assert owner_client.patch(f"/api/v1/tickets/{first['id']}/", {"priority": "low", "version": 1}, format="json").status_code == 409

    summary = owner_client.get("/api/v1/tickets/summary/").json()
    assert summary == {"open": 1, "in_progress": 0, "resolved": 1, "satisfaction": 100, "rated": 1}

    listed = owner_client.get("/api/v1/tickets/?status=open").json()["results"]
    assert [t["number"] for t in listed] == [1002]
    assert [t["number"] for t in owner_client.get("/api/v1/tickets/?q=whatsapp").json()["results"]] == [1001]

    # reopening clears the resolution and the rating that described it
    resp = owner_client.patch(f"/api/v1/tickets/{first['id']}/", {"status": "open", "version": 2}, format="json")
    assert resp.json()["resolved_at"] is None and resp.json()["rating"] is None

    assert owner_client.delete(f"/api/v1/tickets/{second['id']}/").status_code == 204
    assert _events(org_a, "tickets.deleted")


def test_ticket_validation(owner_client):
    assert owner_client.post("/api/v1/tickets/", {}, format="json").status_code == 400
    assert _create(owner_client, subject="   ").status_code == 400
    assert _create(owner_client, priority="critical").status_code == 400
    assert _create(owner_client, rating=6).status_code == 400
    # a rating needs a resolved ticket
    assert _create(owner_client, rating=4).status_code == 400
    assert owner_client.get("/api/v1/tickets/?sort=secret").status_code == 400
    assert owner_client.get("/api/v1/tickets/?unknown=1").status_code == 400


def test_ticket_tenant_isolation(org_a, org_b, owner_client, client_for, crm):
    ticket = _create(owner_client).json()
    other = client_for(org_b.owner, org_b.owner_membership)
    assert other.get(f"/api/v1/tickets/{ticket['id']}/").status_code == 404
    assert other.patch(f"/api/v1/tickets/{ticket['id']}/", {"priority": "low", "version": 1}, format="json").status_code == 404
    assert other.delete(f"/api/v1/tickets/{ticket['id']}/").status_code == 404
    assert other.get("/api/v1/tickets/").json()["results"] == []
    assert other.get("/api/v1/tickets/summary/").json()["open"] == 0
    # numbering is per organization
    assert _create(other).json()["number"] == 1001
    # a contact from another organization does not validate as a requester
    foreign = crm.make_contact(org_b)
    resp = _create(owner_client, contact_id=str(foreign.pk))
    assert resp.status_code == 400


def test_ticket_scopes_follow_the_assignee(org_a, owner_client, client_for, make_member):
    rep = make_member(org_a, "sales_rep")
    peer = make_member(org_a, "sales_rep")
    viewer = make_member(org_a, "viewer")
    rep_client = client_for(rep.user, rep)
    peer_client = client_for(peer.user, peer)
    viewer_client = client_for(viewer.user, viewer)

    own = _create(rep_client).json()
    assert own["owner"]["id"] == str(rep.pk)
    # a rep may not assign tickets to someone else
    assert _create(rep_client, owner_id=str(peer.pk)).status_code == 403

    mine = _create(owner_client).json()
    # the rep cannot edit a ticket assigned to someone else, nor delete tickets at all
    assert rep_client.patch(f"/api/v1/tickets/{mine['id']}/", {"priority": "low", "version": 1}, format="json").status_code in (403, 404)
    assert rep_client.delete(f"/api/v1/tickets/{own['id']}/").status_code == 403
    assert rep_client.patch(f"/api/v1/tickets/{own['id']}/", {"status": "in_progress", "version": 1}, format="json").status_code == 200
    assert peer_client.patch(f"/api/v1/tickets/{own['id']}/", {"priority": "low", "version": 2}, format="json").status_code in (403, 404)

    # a viewer reads every ticket and changes none
    assert len(viewer_client.get("/api/v1/tickets/").json()["results"]) == 2
    assert _create(viewer_client).status_code == 403

    # the owner reassigns
    resp = owner_client.patch(f"/api/v1/tickets/{mine['id']}/", {"owner_id": str(rep.pk), "version": 1}, format="json")
    assert resp.status_code == 200 and resp.json()["owner"]["id"] == str(rep.pk)
