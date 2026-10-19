"""Milestone 2 deals: product lines with tax and a computed amount, price books, stock flag, line field
permissions, connected deals (manual links and the M5 hook), and events for every mutation."""

from __future__ import annotations

import pytest

from apps.audit.models import AuditEvent
from apps.deals import services as deal_services
from apps.deals.models import Deal, DealConnection
from tests.m2_helpers import captured_events, in_org, restrict

pytestmark = pytest.mark.django_db


def _add_line(client, deal_id, product_id, **extra):
    return client.post(
        f"/api/v1/deals/{deal_id}/products/add/", {"product_id": str(product_id), **extra}, format="json"
    )


def test_amount_recomputes_from_quantity_discount_and_tax(org_a, owner_client, crm):
    """Acceptance: a deal carries product lines and its amount recomputes from them."""
    deal = crm.make_deal(org_a, amount="0.00", amount_base="0.00")
    widget = crm.make_product(org_a, unit_price="200.00", tax_rate="10")
    gadget = crm.make_product(org_a, unit_price="50.00", tax_rate="0")
    with captured_events() as events:
        line = _add_line(owner_client, deal.pk, widget.pk, quantity="3", discount_percent="25")
    assert line.status_code == 201, line.content
    # 3 x 200 = 600, less 25% = 450.00, +10% tax = 45.00 -> 495.00
    body = line.json()
    assert (body["subtotal"], body["tax_amount"], body["line_total"]) == ("450.00", "45.00", "495.00")
    assert any(e.entity_type == "deal" and "amount" in e.fields for e in events)
    _add_line(owner_client, deal.pk, gadget.pk, quantity="2")
    detail = owner_client.get(f"/api/v1/deals/{deal.pk}/").json()
    assert detail["amount"] == "595.00" and detail["amount_base"] == "595.00" and detail["amount_from_lines"]
    assert detail["version"] == 3  # each line change bumps the version

    # a manual amount is refused while lines drive it
    resp = owner_client.patch(f"/api/v1/deals/{deal.pk}/", {"amount": "1", "version": 3}, format="json")
    assert resp.status_code == 409 and resp.json()["type"] == "amount_from_lines"

    lines = owner_client.get(f"/api/v1/deals/{deal.pk}/products/").json()["results"]
    first = next(x for x in lines if x["product"]["id"] == str(widget.pk))
    upd = owner_client.patch(
        f"/api/v1/deals/{deal.pk}/products/{first['id']}/", {"quantity": "1", "discount_percent": "0"}, format="json"
    )
    assert upd.json()["line_total"] == "220.00"
    assert owner_client.get(f"/api/v1/deals/{deal.pk}/").json()["amount"] == "320.00"

    # stale version on a line change is a conflict
    stale = owner_client.patch(
        f"/api/v1/deals/{deal.pk}/products/{first['id']}/", {"quantity": "2", "version": 1}, format="json"
    )
    assert stale.status_code == 409

    for x in owner_client.get(f"/api/v1/deals/{deal.pk}/products/").json()["results"]:
        assert owner_client.post(f"/api/v1/deals/{deal.pk}/products/{x['id']}/remove/").status_code == 204
    detail = owner_client.get(f"/api/v1/deals/{deal.pk}/").json()
    # unlocked again; the amount keeps the last computed value (the gadget line, 2 x 50)
    assert detail["amount_from_lines"] is False and detail["amount"] == "100.00"
    assert (
        owner_client.patch(
            f"/api/v1/deals/{deal.pk}/", {"amount": "999", "version": detail["version"]}, format="json"
        ).status_code
        == 200
    )
    with in_org(org_a):
        actions = set(AuditEvent.objects.filter(resource_id=str(deal.pk)).values_list("action", flat=True))
    assert {"deals.product_added", "deals.product_updated", "deals.product_removed"} <= actions


def test_price_book_prices_new_lines(org_a, owner_client, crm):
    product = crm.make_product(org_a, unit_price="100.00")
    book = owner_client.post(
        "/api/v1/price-books/", {"name": "Partners", "currency": org_a.org.base_currency}, format="json"
    )
    assert book.status_code == 201, book.content
    book = book.json()
    resp = owner_client.put(
        f"/api/v1/price-books/{book['id']}/entries/set/",
        {"entries": [{"product_id": str(product.pk), "unit_price": "80.00"}]},
        format="json",
    )
    assert resp.status_code == 200 and resp.json()["results"][0]["unit_price"] == "80.00"
    deal = crm.make_deal(org_a)
    patched = owner_client.patch(
        f"/api/v1/deals/{deal.pk}/", {"price_book_id": book["id"], "version": 1}, format="json"
    )
    assert patched.status_code == 200 and patched.json()["price_book"]["id"] == book["id"]
    line = _add_line(owner_client, deal.pk, product.pk, quantity="1").json()
    assert line["unit_price"] == "80.00"
    # a book in another currency cannot be used
    other = owner_client.post("/api/v1/price-books/", {"name": "USD list", "currency": "USD"}, format="json").json()
    if other["currency"] != org_a.org.base_currency:
        deal2 = crm.make_deal(org_a)
        bad = owner_client.patch(
            f"/api/v1/deals/{deal2.pk}/", {"price_book_id": other["id"], "version": 1}, format="json"
        )
        assert bad.status_code == 400
    with in_org(org_a):
        assert AuditEvent.objects.filter(action="pricebooks.prices_changed").exists()


def test_price_books_need_their_permission(org_a, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    client = client_for(rep.user, rep)
    assert client.get("/api/v1/price-books/").status_code == 200
    assert client.post("/api/v1/price-books/", {"name": "Mine"}, format="json").status_code == 403


def test_stock_flag(org_a, owner_client):
    resp = owner_client.post("/api/v1/products/", {"name": "Widget", "in_stock": False}, format="json")
    assert resp.status_code == 201 and resp.json()["in_stock"] is False
    assert owner_client.get("/api/v1/products/?in_stock=false").json()["results"][0]["name"] == "Widget"


def test_line_items_obey_field_permissions(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    deal = crm.make_deal(org_a, owner=rep)
    product = crm.make_product(org_a, unit_price="10.00")
    client = client_for(rep.user, rep)
    restrict(
        owner_client,
        "sales_rep",
        "deal_line",
        [{"field": "unit_price", "access": "hidden"}, {"field": "discount_percent", "access": "read_only"}],
    )
    line = _add_line(client, deal.pk, product.pk, quantity="2")
    assert line.status_code == 201, line.content
    body = line.json()
    assert "unit_price" not in body and "line_total" not in body and "subtotal" not in body
    assert body["quantity"] == "2.000"
    refused = client.patch(f"/api/v1/deals/{deal.pk}/products/{body['id']}/", {"discount_percent": "5"}, format="json")
    assert refused.status_code == 403 and refused.json()["type"] == "field_read_only"
    priced = _add_line(client, deal.pk, crm.make_product(org_a).pk, unit_price="1.00")
    assert priced.status_code == 403  # a hidden field is not writable either
    # a read-only deal amount makes the lines (which set it) read-only too
    restrict(owner_client, "sales_rep", "deal", [{"field": "amount", "access": "read_only"}])
    assert (
        client.patch(f"/api/v1/deals/{deal.pk}/products/{body['id']}/", {"quantity": "3"}, format="json").status_code
        == 403
    )
    # a hidden deal amount hides line money everywhere
    restrict(owner_client, "sales_rep", "deal_line", [])
    restrict(owner_client, "sales_rep", "deal", [{"field": "amount", "access": "hidden"}])
    listed = client.get(f"/api/v1/deals/{deal.pk}/products/").json()["results"][0]
    assert "line_total" not in listed and "unit_price" not in listed
    assert "products_total" not in client.get(f"/api/v1/deals/{deal.pk}/").json()


def test_connected_deals_show_on_both_records(org_a, owner_client, crm):
    """Acceptance: two records in different pipelines can be linked and each shows the other."""
    sales = crm.make_deal(org_a, name="Acme - new business")
    onboarding = owner_client.post(
        "/api/v1/pipelines/", {"name": "Onboarding", "template": "services"}, format="json"
    ).json()
    project = owner_client.post(
        "/api/v1/deals/", {"name": "Acme - onboarding", "pipeline_id": onboarding["id"]}, format="json"
    ).json()
    with captured_events() as events:
        link = owner_client.post(
            f"/api/v1/deals/{sales.pk}/connections/add/", {"target_id": project["id"]}, format="json"
        )
    assert link.status_code == 201, link.content
    assert {e.change for e in events} == {"linked"} and len(events) == 2
    assert events[0].related  # each side names the other
    from_sales = owner_client.get(f"/api/v1/deals/{sales.pk}/connections/").json()["results"]
    from_project = owner_client.get(f"/api/v1/deals/{project['id']}/connections/").json()["results"]
    assert from_sales[0]["deal"]["id"] == project["id"] and from_sales[0]["direction"] == "outgoing"
    assert from_sales[0]["deal"]["pipeline"]["name"] == "Onboarding"
    assert from_project[0]["deal"]["id"] == str(sales.pk) and from_project[0]["direction"] == "incoming"
    # either direction again is a duplicate
    dup = owner_client.post(
        f"/api/v1/deals/{project['id']}/connections/add/", {"target_id": str(sales.pk)}, format="json"
    )
    assert dup.status_code == 409
    assert (
        owner_client.post(
            f"/api/v1/deals/{sales.pk}/connections/add/", {"target_id": str(sales.pk)}, format="json"
        ).status_code
        == 400
    )
    removed = owner_client.post(f"/api/v1/deals/{project['id']}/connections/{from_project[0]['id']}/remove/")
    assert removed.status_code == 204
    assert owner_client.get(f"/api/v1/deals/{sales.pk}/connections/").json()["results"] == []


def test_connections_hide_deals_the_viewer_cannot_see(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    mine = crm.make_deal(org_a, owner=rep)
    secret = crm.make_deal(org_a, name="Board-level secret")
    owner_client.post(f"/api/v1/deals/{secret.pk}/connections/add/", {"target_id": str(mine.pk)}, format="json")
    client = client_for(rep.user, rep)
    assert client.get(f"/api/v1/deals/{mine.pk}/connections/").json()["results"] == []
    # and cannot link to a deal outside their scope
    assert (
        client.post(
            f"/api/v1/deals/{mine.pk}/connections/add/", {"target_id": str(secret.pk)}, format="json"
        ).status_code
        == 400
    )


def test_connected_deal_hook_for_workflows(org_a, crm):
    """The M5 workflow action calls this: create a deal in another pipeline and connect it."""
    from apps.authz.actor import build_actor
    from apps.pipelines.services import create_pipeline

    source = crm.make_deal(org_a, name="Acme expansion")
    with in_org(org_a):
        actor = build_actor(org_a.owner_membership)
        target_pipeline = create_pipeline(actor, name="Delivery", template="services")
        created = deal_services.create_connected_deal(actor, source, pipeline=target_pipeline)
        assert created.pipeline_id == target_pipeline.pk and created.name == "Acme expansion"
        link = DealConnection.objects.get(source=source, target=created)
        assert link.origin == "automation"
        assert Deal.objects.filter(pipeline=target_pipeline).count() == 1


def test_connections_are_tenant_isolated(org_a, org_b, owner_client, crm):
    mine = crm.make_deal(org_a)
    foreign = crm.make_deal(org_b)
    resp = owner_client.post(f"/api/v1/deals/{mine.pk}/connections/add/", {"target_id": str(foreign.pk)}, format="json")
    assert resp.status_code == 400
    assert owner_client.get(f"/api/v1/deals/{foreign.pk}/connections/").status_code == 404
