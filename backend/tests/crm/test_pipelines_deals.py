"""Pipelines, stages, deals, stage moves (authorisation, concurrency, history, audit), lines, board."""

from __future__ import annotations

import threading

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.audit.models import AuditEvent
from apps.core.tenancy.context import tenant_context
from apps.deals.models import Deal, DealStageHistory

pytestmark = pytest.mark.django_db


def test_default_pipeline_created_with_organization(org_a, owner_client):
    resp = owner_client.get("/api/v1/pipelines/")
    assert resp.status_code == 200
    pipelines = resp.json()["results"]
    assert len(pipelines) == 1 and pipelines[0]["is_default"]
    kinds = [s["kind"] for s in pipelines[0]["stages"]]
    assert kinds == ["open", "open", "open", "open", "won", "lost"]


def test_pipeline_and_stage_management(org_a, owner_client, crm):
    resp = owner_client.post("/api/v1/pipelines/", {"name": "Partners"}, format="json")
    assert resp.status_code == 201, resp.content
    pid = resp.json()["id"]
    assert resp.json()["is_default"] is False
    assert owner_client.post("/api/v1/pipelines/", {"name": "partners"}, format="json").status_code == 409
    # custom stages must include won + lost
    resp = owner_client.post(
        "/api/v1/pipelines/", {"name": "Broken", "stages": [{"name": "Only", "kind": "open"}]}, format="json"
    )
    assert resp.status_code == 400
    # add / update / reorder / archive stages
    resp = owner_client.post(
        f"/api/v1/pipelines/{pid}/stages/",
        {"name": "Demo", "default_probability": 40, "color_token": "purple"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    sid = resp.json()["id"]
    assert owner_client.post(f"/api/v1/pipelines/{pid}/stages/", {"name": "demo"}, format="json").status_code == 409
    assert owner_client.patch(f"/api/v1/stages/{sid}/", {"default_probability": 500}, format="json").status_code == 400
    assert owner_client.patch(f"/api/v1/stages/{sid}/", {"name": "Demo call"}, format="json").status_code == 200
    stages = owner_client.get(f"/api/v1/pipelines/{pid}/").json()["stages"]
    order = [s["id"] for s in stages]
    order.insert(0, order.pop())  # move the new stage to the front
    resp = owner_client.post(f"/api/v1/pipelines/{pid}/stages/reorder/", {"stage_ids": order}, format="json")
    assert resp.status_code == 200, resp.content
    assert [s["id"] for s in resp.json()["stages"]] == order
    assert [s["position"] for s in resp.json()["stages"]] == list(range(len(order)))
    resp = owner_client.post(f"/api/v1/pipelines/{pid}/stages/reorder/", {"stage_ids": order[:-1]}, format="json")
    assert resp.status_code == 400
    # cannot archive the only won stage
    won = next(s for s in stages if s["kind"] == "won")
    assert owner_client.delete(f"/api/v1/stages/{won['id']}/").status_code == 400
    assert owner_client.delete(f"/api/v1/stages/{sid}/").status_code == 204
    # default switching
    resp = owner_client.patch(f"/api/v1/pipelines/{pid}/", {"is_default": True}, format="json")
    assert resp.status_code == 200 and resp.json()["is_default"] is True
    others = [p for p in owner_client.get("/api/v1/pipelines/").json()["results"] if p["id"] != pid]
    assert all(not p["is_default"] for p in others)
    # archiving the default is refused; a non-default empty pipeline archives fine
    assert owner_client.delete(f"/api/v1/pipelines/{pid}/").status_code == 409
    assert owner_client.delete(f"/api/v1/pipelines/{others[0]['id']}/").status_code == 204


def test_deal_create_stage_rules_and_money(org_a, owner_client, crm):
    pipeline = crm.make_pipeline(org_a)
    company = crm.make_company(org_a)
    contact = crm.make_contact(org_a, company=company)
    resp = owner_client.post(
        "/api/v1/deals/",
        {
            "name": "Big deal",
            "amount": "1000",
            "currency": "usd",
            "exchange_rate": "83.5",
            "company_id": str(company.pk),
            "primary_contact_id": str(contact.pk),
            "expected_close_date": "2026-12-31",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    deal = resp.json()
    assert deal["currency"] == "USD"
    assert deal["amount_base"] == "83500.00"
    assert deal["stage"]["name"] == "Qualification" and deal["status"] == "open"
    assert deal["pipeline"]["id"] == str(pipeline.pk)
    assert deal["probability"] == 10
    # explicit stage must belong to the pipeline
    other = owner_client.post("/api/v1/pipelines/", {"name": "Other"}, format="json").json()
    resp = owner_client.post(
        "/api/v1/deals/",
        {"name": "x", "pipeline_id": str(pipeline.pk), "stage_id": other["stages"][0]["id"]},
        format="json",
    )
    assert resp.status_code == 400
    # creating directly in a won stage closes the deal
    won = crm.stage_named(pipeline, "Closed won")
    resp = owner_client.post(
        "/api/v1/deals/", {"name": "Won already", "stage_id": str(won.pk), "amount": "10"}, format="json"
    )
    assert resp.status_code == 201 and resp.json()["status"] == "won" and resp.json()["closed_at"]
    # money validation
    assert owner_client.post("/api/v1/deals/", {"name": "x", "amount": "-1"}, format="json").status_code == 400
    assert owner_client.post("/api/v1/deals/", {"name": "x", "exchange_rate": "0"}, format="json").status_code == 400
    assert owner_client.post("/api/v1/deals/", {"name": "x", "currency": "dollars"}, format="json").status_code == 400
    # stage/pipeline changes are refused on PATCH (must use the stage endpoint)
    resp = owner_client.patch(f"/api/v1/deals/{deal['id']}/", {"stage_id": str(won.pk), "version": 1}, format="json")
    assert resp.status_code == 400
    resp = owner_client.patch(f"/api/v1/deals/{deal['id']}/", {"amount": "2000", "version": 1}, format="json")
    assert resp.status_code == 200 and resp.json()["amount_base"] == "167000.00"


def test_stage_move_records_history_status_and_audit(org_a, owner_client, crm):
    pipeline = crm.make_pipeline(org_a)
    deal = crm.make_deal(org_a)
    proposal = crm.stage_named(pipeline, "Proposal")
    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": str(proposal.pk), "version": 1}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert (
        resp.json()["stage"]["id"] == str(proposal.pk)
        and resp.json()["version"] == 2
        and resp.json()["probability"] == 50
    )
    # stale version → 409, nothing changes
    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/stage/",
        {"stage_id": str(crm.stage_named(pipeline, "Negotiation").pk), "version": 1},
        format="json",
    )
    assert resp.status_code == 409
    # stage from another pipeline → 400
    other = owner_client.post("/api/v1/pipelines/", {"name": "Other"}, format="json").json()
    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": other["stages"][0]["id"], "version": 2}, format="json"
    )
    assert resp.status_code == 400
    # missing version → 428
    assert (
        owner_client.post(f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": str(proposal.pk)}, format="json").status_code
        == 428
    )
    # lost with reason
    lost = crm.stage_named(pipeline, "Closed lost")
    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/stage/",
        {"stage_id": str(lost.pk), "version": 2, "lost_reason": "Budget"},
        format="json",
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (
        body["status"] == "lost" and body["lost_reason"] == "Budget" and body["closed_at"] and body["probability"] == 0
    )
    # reopen
    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/stage/",
        {"stage_id": str(crm.stage_named(pipeline, "Qualification").pk), "version": 3},
        format="json",
    )
    assert resp.json()["status"] == "open" and resp.json()["closed_at"] is None and resp.json()["lost_reason"] == ""
    history = owner_client.get(f"/api/v1/deals/{deal.pk}/history/").json()["results"]
    assert [h["to_stage"]["name"] for h in history] == ["Qualification", "Closed lost", "Proposal", "Qualification"]
    assert history[0]["changed_by"]["id"] == str(org_a.owner_membership.pk)
    assert history[0]["duration_seconds"] is not None
    with tenant_context(org_a.org.pk):
        assert AuditEvent.objects.filter(action="deals.stage_changed").count() == 3
        # history is append-only at the database level
        from django.db import DatabaseError, transaction

        row = DealStageHistory.objects.filter(deal_id=deal.pk).first()
        with pytest.raises(DatabaseError), transaction.atomic():
            DealStageHistory.objects.filter(pk=row.pk).update(source="automation")
        with pytest.raises(DatabaseError), transaction.atomic():
            DealStageHistory.objects.filter(pk=row.pk).delete()


def test_stage_move_authorization(org_a, crm, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    viewer = make_member(org_a, "viewer")
    manager = make_member(org_a, "sales_manager")
    pipeline = crm.make_pipeline(org_a)
    target = crm.stage_named(pipeline, "Proposal")
    own_deal = crm.make_deal(org_a, owner=rep)
    other_deal = crm.make_deal(org_a, owner=manager)
    repc = client_for(rep.user, rep)
    assert (
        repc.post(
            f"/api/v1/deals/{own_deal.pk}/stage/", {"stage_id": str(target.pk), "version": 1}, format="json"
        ).status_code
        == 200
    )
    # the rep cannot see the manager's deal at all (team scope) → 404
    assert (
        repc.post(
            f"/api/v1/deals/{other_deal.pk}/stage/", {"stage_id": str(target.pk), "version": 1}, format="json"
        ).status_code
        == 404
    )
    # a viewer sees every deal but may not move any → 403
    viewc = client_for(viewer.user, viewer)
    assert viewc.get(f"/api/v1/deals/{own_deal.pk}/").status_code == 200
    assert (
        viewc.post(
            f"/api/v1/deals/{own_deal.pk}/stage/", {"stage_id": str(target.pk), "version": 2}, format="json"
        ).status_code
        == 403
    )
    with tenant_context(org_a.org.pk):
        assert Deal.objects.get(pk=other_deal.pk).stage_id != target.pk


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_concurrent_stage_moves_apply_exactly_once(org_a, crm, client_for):
    """Two clients race with the same version: one wins (200), the other conflicts (409)."""
    pipeline = crm.make_pipeline(org_a)
    deal = crm.make_deal(org_a)
    targets = [crm.stage_named(pipeline, "Proposal"), crm.stage_named(pipeline, "Negotiation")]
    results: list[int] = []
    bodies: list[bytes] = []
    barrier = threading.Barrier(2)

    def worker(stage):
        try:
            client = client_for(org_a.owner, org_a.owner_membership)
            barrier.wait(timeout=10)
            resp = client.post(
                f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": str(stage.pk), "version": 1}, format="json"
            )
            results.append(resp.status_code)
            bodies.append(resp.content[:300])
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(t,)) for t in targets]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert sorted(results) == [200, 409], (results, bodies)
    with tenant_context(org_a.org.pk):
        fresh = Deal.objects.get(pk=deal.pk)
        assert fresh.version == 2
        assert DealStageHistory.objects.filter(deal=fresh).count() == 2  # creation + exactly one move


def test_deal_products_and_contacts(org_a, owner_client, crm):
    deal = crm.make_deal(org_a)
    product = crm.make_product(org_a, unit_price="250.00", tax_rate="18")
    inactive = crm.make_product(org_a, status="inactive")
    contact = crm.make_contact(org_a)
    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/products/add/",
        {"product_id": str(product.pk), "quantity": "3", "discount_percent": "10"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    line = resp.json()
    assert line["line_total"] == "675.00" and line["tax_rate"] == "18.00" and line["currency"] == deal.currency
    assert (
        owner_client.post(
            f"/api/v1/deals/{deal.pk}/products/add/", {"product_id": str(product.pk)}, format="json"
        ).status_code
        == 409
    )
    assert (
        owner_client.post(
            f"/api/v1/deals/{deal.pk}/products/add/", {"product_id": str(inactive.pk)}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.post(
            f"/api/v1/deals/{deal.pk}/products/add/", {"product_id": str(product.pk), "quantity": "0"}, format="json"
        ).status_code
        == 400
    )
    resp = owner_client.patch(
        f"/api/v1/deals/{deal.pk}/products/{line['id']}/", {"quantity": "2", "discount_percent": "0"}, format="json"
    )
    assert resp.status_code == 200 and resp.json()["line_total"] == "500.00"
    detail = owner_client.get(f"/api/v1/deals/{deal.pk}/").json()
    assert detail["line_count"] == 1 and detail["products_total"] == "500.00"
    assert owner_client.post(f"/api/v1/deals/{deal.pk}/products/{line['id']}/remove/").status_code == 204
    assert owner_client.get(f"/api/v1/deals/{deal.pk}/products/").json()["results"] == []

    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/contacts/add/",
        {"contact_id": str(contact.pk), "role_label": "Champion"},
        format="json",
    )
    assert resp.status_code == 201 and resp.json()["contact"]["id"] == str(contact.pk)
    assert len(owner_client.get(f"/api/v1/deals/{deal.pk}/contacts/").json()["results"]) == 1
    assert (
        owner_client.post(
            f"/api/v1/deals/{deal.pk}/contacts/remove/", {"contact_id": str(contact.pk)}, format="json"
        ).status_code
        == 204
    )
    assert (
        owner_client.post(
            f"/api/v1/deals/{deal.pk}/contacts/remove/", {"contact_id": "nope"}, format="json"
        ).status_code
        == 400
    )


def test_board_is_scoped_and_aggregated(org_a, crm, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    manager = make_member(org_a, "sales_manager")
    pipeline = crm.make_pipeline(org_a)
    proposal = crm.stage_named(pipeline, "Proposal")
    crm.make_deal(org_a, owner=rep, amount="100.00", amount_base="100.00")
    crm.make_deal(org_a, owner=rep, stage=proposal, amount="50.00", amount_base="50.00")
    crm.make_deal(org_a, owner=manager, stage=proposal, amount="1000.00", amount_base="1000.00")
    mgr = client_for(manager.user, manager).get(f"/api/v1/deals/board/?pipeline={pipeline.pk}").json()
    by_name = {s["name"]: s for s in mgr["stages"]}
    assert by_name["Proposal"]["deal_count"] == 2 and by_name["Proposal"]["total_amount_base"] == "1050.00"
    repb = client_for(rep.user, rep).get(f"/api/v1/deals/board/?pipeline={pipeline.pk}").json()
    by_name = {s["name"]: s for s in repb["stages"]}
    assert by_name["Proposal"]["deal_count"] == 1 and by_name["Proposal"]["total_amount_base"] == "50.00"
    assert by_name["Qualification"]["deal_count"] == 1
    assert {d["id"] for s in repb["stages"] for d in s["deals"]} <= {d["id"] for s in mgr["stages"] for d in s["deals"]}
    assert (
        client_for(rep.user, rep).get("/api/v1/deals/board/?pipeline=00000000-0000-0000-0000-000000000000").status_code
        == 404
    )
    assert client_for(rep.user, rep).get("/api/v1/deals/board/?bogus=1").status_code == 400


def test_board_card_carries_only_what_the_card_draws(org_a, crm, owner_client):
    """The Kanban card is a deliberate subset of the deal.

    Two things are being held in place. Payload: a board renders up to 300 cards, so a field added
    here is paid for 300 times - ``description`` alone is 5000 characters per deal. Disclosure: the
    card shows a contact's name, so the board ships a name and not the contact's email or phone.
    """
    pipeline = crm.make_pipeline(org_a)
    contact = crm.make_contact(org_a, email="buyer@example.com", phone="+15550001111")
    crm.make_deal(org_a, contact=contact, description="x" * 5000)
    card = owner_client.get(f"/api/v1/deals/board/?pipeline={pipeline.pk}").json()["stages"][0]["deals"][0]

    assert set(card) == {
        "id",
        "name",
        "stage",
        "company",
        "primary_contact",
        "owner",
        "amount",
        "currency",
        "amount_base",
        "weighted_amount_base",
        "probability",
        "probability_overridden",
        "expected_close_date",
        "status",
        "next_activity_title",
        "risk_level",
        "version",
    }
    assert set(card["primary_contact"]) == {"id", "name"}
    assert "buyer@example.com" not in str(card) and "+15550001111" not in str(card)


def test_board_query_count_does_not_grow_with_the_number_of_deals(org_a, crm, owner_client):
    """Query budget: the board costs a fixed number of statements per stage, not per deal.

    It is a budget, not a measurement of speed - it fails when someone reintroduces an N+1 (a nested
    serializer, a per-card lookup), which is the regression that actually hurts a large tenant.
    """
    pipeline = crm.make_pipeline(org_a)
    proposal = crm.stage_named(pipeline, "Proposal")
    for i in range(3):
        crm.make_deal(org_a, name=f"small {i}", stage=proposal)
    owner_client.get(f"/api/v1/deals/board/?pipeline={pipeline.pk}")  # warm caches
    with CaptureQueriesContext(connection) as few:
        owner_client.get(f"/api/v1/deals/board/?pipeline={pipeline.pk}")

    for i in range(25):
        crm.make_deal(org_a, name=f"many {i}", stage=proposal)
    with CaptureQueriesContext(connection) as many:
        resp = owner_client.get(f"/api/v1/deals/board/?pipeline={pipeline.pk}")

    assert resp.status_code == 200
    assert sum(len(s["deals"]) for s in resp.json()["stages"]) == 28
    assert len(many.captured_queries) == len(few.captured_queries)
