"""Notes hang off records the actor can view; the timeline merges notes and stage history; search is scoped."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.django_db


def test_notes_follow_record_visibility_and_author_scope(org_a, crm, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    other_rep = make_member(org_a, "sales_rep")
    manager = make_member(org_a, "sales_manager")
    own = crm.make_contact(org_a, owner=rep)
    hidden = crm.make_contact(org_a, owner=manager)
    repc = client_for(rep.user, rep)
    resp = repc.post(
        "/api/v1/notes/",
        {"entity_type": "contact", "entity_id": str(own.pk), "body": "  Called, follow up <b>Friday</b>  "},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    note = resp.json()
    assert note["body"] == "Called, follow up <b>Friday</b>" and note["author"]["id"] == str(rep.pk)
    # cannot note a record outside the view scope (404, no existence leak)
    assert (
        repc.post(
            "/api/v1/notes/", {"entity_type": "contact", "entity_id": str(hidden.pk), "body": "x"}, format="json"
        ).status_code
        == 404
    )
    assert repc.get(f"/api/v1/notes/?entity_type=contact&entity_id={hidden.pk}").status_code == 404
    assert (
        repc.post(
            "/api/v1/notes/", {"entity_type": "user", "entity_id": str(own.pk), "body": "x"}, format="json"
        ).status_code
        == 400
    )
    assert (
        repc.post(
            "/api/v1/notes/", {"entity_type": "contact", "entity_id": str(own.pk), "body": ""}, format="json"
        ).status_code
        == 400
    )
    # listing per record
    resp = repc.get(f"/api/v1/notes/?entity_type=contact&entity_id={own.pk}")
    assert [n["id"] for n in resp.json()["results"]] == [note["id"]]
    # another rep in no team cannot see the record → 404 on the note
    otherc = client_for(other_rep.user, other_rep)
    assert otherc.get(f"/api/v1/notes/{note['id']}/").status_code == 404
    # the manager can read and edit anyone's note; the author can edit own; other reps cannot
    mgr = client_for(manager.user, manager)
    assert mgr.patch(f"/api/v1/notes/{note['id']}/", {"pinned": True}, format="json").status_code == 200
    assert repc.patch(f"/api/v1/notes/{note['id']}/", {"body": "edited"}, format="json").status_code == 200
    assert otherc.patch(f"/api/v1/notes/{note['id']}/", {"body": "hijack"}, format="json").status_code == 404
    assert repc.get("/api/v1/notes/").status_code == 200  # own notes
    assert repc.delete(f"/api/v1/notes/{note['id']}/").status_code == 204


def test_timeline_merges_events(org_a, owner_client, crm):
    pipeline = crm.make_pipeline(org_a)
    company = crm.make_company(org_a)
    deal = crm.make_deal(org_a, company=company)
    owner_client.post(
        "/api/v1/notes/", {"entity_type": "deal", "entity_id": str(deal.pk), "body": "kickoff"}, format="json"
    )
    owner_client.post(
        f"/api/v1/deals/{deal.pk}/stage/",
        {"stage_id": str(crm.stage_named(pipeline, "Proposal").pk), "version": 1},
        format="json",
    )
    resp = owner_client.get(f"/api/v1/timeline/?entity_type=deal&entity_id={deal.pk}")
    assert resp.status_code == 200
    kinds = [e["kind"] for e in resp.json()["results"]]
    assert kinds[0] == "deal.stage_changed" and "note" in kinds and "record.created" in kinds
    assert all("occurred_at" in e for e in resp.json()["results"])
    resp = owner_client.get(f"/api/v1/timeline/?entity_type=company&entity_id={company.pk}")
    assert "deal.linked" in [e["kind"] for e in resp.json()["results"]]
    assert (
        owner_client.get(
            "/api/v1/timeline/?entity_type=deal&entity_id=00000000-0000-0000-0000-000000000000"
        ).status_code
        == 404
    )
    assert owner_client.get("/api/v1/timeline/?entity_type=deal").status_code == 400


def test_global_search_is_tenant_and_scope_bound(org_a, org_b, crm, make_member, client_for, owner_client):
    rep = make_member(org_a, "sales_rep")
    manager = make_member(org_a, "sales_manager")
    crm.make_contact(org_a, first_name="Marie", last_name="Curie", email="marie@radium.fr", owner=rep)
    crm.make_contact(org_a, first_name="Marie", last_name="Antoinette", owner=manager)
    crm.make_company(org_a, name="Radium Institute")
    crm.make_product(org_a, name="Radium sample", sku="RA-1")
    crm.make_contact(org_b, first_name="Marie", last_name="Hidden")
    crm.make_company(org_b, name="Radium B")

    resp = owner_client.get("/api/v1/search/?q=radium")
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert {r["title"] for r in results["company"]} == {"Radium Institute"}
    assert {r["title"] for r in results["product"]} == {"Radium sample"}
    assert {r["title"] for r in results["contact"]} == {"Marie Curie"}  # via email
    resp = owner_client.get("/api/v1/search/?q=marie&types=contact")
    assert {r["title"] for r in resp.json()["results"]["contact"]} == {"Marie Curie", "Marie Antoinette"}
    # the rep only sees own/team contacts
    resp = client_for(rep.user, rep).get("/api/v1/search/?q=marie")
    assert {r["title"] for r in resp.json()["results"]["contact"]} == {"Marie Curie"}
    # prefix while typing
    assert owner_client.get("/api/v1/search/?q=mar&types=contact").json()["results"]["contact"]
    # hostile input is parameterised, never interpolated
    for q in [
        "' OR 1=1 --",
        "radium') OR true --",
        "a:* | b & !c",
        "\x00\x00",
        "%",
        "_",
        "'; DROP TABLE contacts_contact; --",
    ]:
        resp = owner_client.get("/api/v1/search/", {"q": q})
        assert resp.status_code in (200, 400), q  # 400 only for NUL bytes (rejected by the serializer)
        assert resp["Content-Type"].startswith("application/json")
        if resp.status_code == 200:
            assert all("Hidden" not in r["title"] for rs in resp.json()["results"].values() for r in rs)
    assert owner_client.get("/api/v1/search/?q=" + "x" * 500).status_code == 400
    assert owner_client.get("/api/v1/search/?q=radium&limit=999").status_code == 400
    assert owner_client.get("/api/v1/search/?q=").json()["results"]["contact"] == []
