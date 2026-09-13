"""Forged organization/owner ids and foreign references across every CRM relation (T1, T8)."""

from __future__ import annotations

import pytest

from apps.contacts.models import Contact
from apps.core.tenancy.context import tenant_context

pytestmark = pytest.mark.django_db

FOREIGN = "/api/v1/{path}"


def test_organization_and_owner_ids_in_payload(org_a, org_b, owner_client, make_member):
    foreign_member = make_member(org_b)
    resp = owner_client.post(
        "/api/v1/contacts/",
        {
            "first_name": "x",
            "organization": str(org_b.org.pk),
            "organization_id": str(org_b.org.pk),
            "version": 99,
            "archived_at": "2020-01-01T00:00:00Z",
            "id": "00000000-0000-0000-0000-000000000009",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["version"] == 1 and body["archived_at"] is None and body["id"] != "00000000-0000-0000-0000-000000000009"
    with tenant_context(org_a.org.pk):
        assert Contact.objects.filter(pk=body["id"]).exists()
    with tenant_context(org_b.org.pk):
        assert not Contact.objects.filter(pk=body["id"]).exists()
    # a membership id from another organization never validates as an owner
    resp = owner_client.post(
        "/api/v1/contacts/", {"first_name": "x", "owner_id": str(foreign_member.pk)}, format="json"
    )
    assert resp.status_code == 400
    assert any(e["field"] == "owner_id" for e in resp.json()["errors"])


def test_foreign_references_are_rejected(org_a, org_b, owner_client, crm):
    foreign_company = crm.make_company(org_b)
    foreign_contact = crm.make_contact(org_b)
    foreign_pipeline = crm.make_pipeline(org_b)
    foreign_stage = crm.stage_named(foreign_pipeline, "Proposal")
    foreign_product = crm.make_product(org_b)
    foreign_tag = crm.make_tag(org_b)

    resp = owner_client.post(
        "/api/v1/contacts/", {"first_name": "x", "company_id": str(foreign_company.pk)}, format="json"
    )
    assert resp.status_code == 400 and any(e["field"] == "company_id" for e in resp.json()["errors"])
    resp = owner_client.post("/api/v1/deals/", {"name": "d", "pipeline_id": str(foreign_pipeline.pk)}, format="json")
    assert resp.status_code == 400
    resp = owner_client.post("/api/v1/deals/", {"name": "d", "stage_id": str(foreign_stage.pk)}, format="json")
    assert resp.status_code == 400
    resp = owner_client.post(
        "/api/v1/deals/",
        {"name": "d", "company_id": str(foreign_company.pk), "primary_contact_id": str(foreign_contact.pk)},
        format="json",
    )
    assert resp.status_code == 400

    deal = crm.make_deal(org_a)
    assert (
        owner_client.post(
            f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": str(foreign_stage.pk), "version": 1}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.post(
            f"/api/v1/deals/{deal.pk}/products/add/", {"product_id": str(foreign_product.pk)}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.post(
            f"/api/v1/deals/{deal.pk}/contacts/add/", {"contact_id": str(foreign_contact.pk)}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.put(
            f"/api/v1/deals/{deal.pk}/tags/", {"tag_ids": [str(foreign_tag.pk)]}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.post(
            "/api/v1/contacts/bulk/", {"ids": [str(foreign_contact.pk)], "action": "archive"}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.post(
            "/api/v1/notes/",
            {"entity_type": "contact", "entity_id": str(foreign_contact.pk), "body": "x"},
            format="json",
        ).status_code
        == 404
    )
    assert owner_client.get(f"/api/v1/notes/?entity_type=company&entity_id={foreign_company.pk}").status_code == 404
    assert owner_client.get(f"/api/v1/timeline/?entity_type=company&entity_id={foreign_company.pk}").status_code == 404
    assert owner_client.get(f"/api/v1/deals/board/?pipeline={foreign_pipeline.pk}").status_code == 404
    assert (
        owner_client.post(f"/api/v1/pipelines/{foreign_pipeline.pk}/stages/", {"name": "x"}, format="json").status_code
        == 404
    )
    assert owner_client.patch(f"/api/v1/stages/{foreign_stage.pk}/", {"name": "x"}, format="json").status_code == 404
    assert owner_client.get(f"/api/v1/contacts/?company={foreign_company.pk}").json()["results"] == []
    assert owner_client.get(f"/api/v1/contacts/?ids={foreign_contact.pk}").json()["results"] == []


def test_foreign_ids_in_deal_stage_history_cannot_be_read(org_a, org_b, owner_client, crm):
    deal_b = crm.make_deal(org_b)
    assert owner_client.get(f"/api/v1/deals/{deal_b.pk}/history/").status_code == 404
    assert owner_client.get(f"/api/v1/deals/{deal_b.pk}/products/").status_code == 404
    assert owner_client.get(f"/api/v1/deals/{deal_b.pk}/contacts/").status_code == 404


def test_search_and_export_never_cross_tenants(
    org_a, org_b, owner_client, crm, reauthenticate, django_capture_on_commit_callbacks
):
    crm.make_contact(org_b, first_name="Zorro", last_name="Secret", email="zorro@b.example")
    resp = owner_client.get("/api/v1/search/?q=zorro")
    assert resp.status_code == 200 and all(not rs for rs in resp.json()["results"].values())
    reauthenticate(owner_client)
    with django_capture_on_commit_callbacks(execute=True):
        job = owner_client.post("/api/v1/exports/contacts/", {}, format="json").json()
    text = owner_client.get(f"/api/v1/exports/contacts/{job['id']}/download/").content.decode("utf-8-sig")
    assert "Zorro" not in text
    foreign_export = crm.make_export_job(org_b)
    assert owner_client.get(f"/api/v1/exports/contacts/{foreign_export.pk}/download/").status_code == 404
    foreign_import = crm.make_import_job(org_b)
    assert (
        owner_client.post(
            f"/api/v1/imports/contacts/{foreign_import.pk}/start/", {"mapping": {"Email": "email"}}, format="json"
        ).status_code
        == 404
    )
