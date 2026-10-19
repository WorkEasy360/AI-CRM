"""Sheet view: batched cell edits (audited and announced per record), conflicts, hidden and read-only
targets refused server-side, per-cell validation, deal stage edits, and windowed reads of a large set."""

from __future__ import annotations

import uuid

import pytest
from django.utils import timezone

from apps.audit.models import AuditEvent
from apps.contacts.models import Contact
from tests.m2_helpers import captured_events, in_org, restrict

pytestmark = pytest.mark.django_db


def _edit(client, entity, rows):
    return client.post(f"/api/v1/records/{entity}/edits/", {"rows": rows}, format="json")


def _bulk_contacts(org, n, *, owner=None, prefix="Row"):
    with in_org(org):
        now = timezone.now()
        Contact.objects.bulk_create(
            [
                Contact(
                    organization_id=org.org.pk,
                    owner=owner or org.owner_membership,
                    first_name=f"{prefix}{i:05d}",
                    last_name="Sheet",
                    email=f"{prefix.lower()}{i}@example.com",
                    created_at=now,
                )
                for i in range(n)
            ],
            batch_size=1000,
        )
        return list(Contact.objects.filter(last_name="Sheet").order_by("first_name"))


def test_bulk_edit_500_rows_audits_and_announces_each_record(org_a, owner_client):
    """Acceptance: Sheet view bulk-edits 500 rows with every change audited and an event emitted."""
    contacts = _bulk_contacts(org_a, 500)
    rows = [
        {"id": str(c.pk), "version": c.version, "values": {"job_title": f"Engineer {i}"}}
        for i, c in enumerate(contacts)
    ]
    with captured_events() as events:
        resp = _edit(owner_client, "contact", rows)
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["saved"] == 500 and body["failed"] == 0
    assert all(r["status"] == "saved" and r["version"] == 2 for r in body["results"])
    updated = [e for e in events if e.entity_type == "contact" and e.change == "updated"]
    assert len(updated) == 500 and {e.entity_ids[0] for e in updated} == {c.pk for c in contacts}
    with in_org(org_a):
        assert AuditEvent.objects.filter(action="contacts.updated").count() == 500
        assert Contact.objects.filter(job_title__startswith="Engineer").count() == 500


def test_concurrent_edit_is_a_conflict_and_saves_nothing_of_that_row(org_a, owner_client, crm):
    contact = crm.make_contact(org_a, first_name="Ada")
    other = crm.make_contact(org_a, first_name="Grace")
    # someone else saves first
    assert (
        owner_client.patch(
            f"/api/v1/contacts/{contact.pk}/", {"job_title": "CTO", "version": 1}, format="json"
        ).status_code
        == 200
    )
    resp = _edit(
        owner_client,
        "contact",
        [
            {"id": str(contact.pk), "version": 1, "values": {"job_title": "CEO"}},
            {"id": str(other.pk), "version": 1, "values": {"job_title": "COO"}},
        ],
    ).json()
    first, second = resp["results"]
    assert first["status"] == "conflict" and first["values"]["job_title"] == "CTO" and first["version"] == 2
    assert second["status"] == "saved"
    with in_org(org_a):
        assert Contact.objects.get(pk=contact.pk).job_title == "CTO"


def test_paste_into_hidden_or_read_only_columns_is_refused(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    contact = crm.make_contact(org_a, owner=rep, phone="+15550100", email="ada@example.com")
    restrict(
        owner_client,
        "sales_rep",
        "contact",
        [{"field": "phone", "access": "hidden"}, {"field": "email", "access": "read_only"}],
    )
    client = client_for(rep.user, rep)
    resp = _edit(
        client,
        "contact",
        [
            {
                "id": str(contact.pk),
                "version": 1,
                "values": {"phone": "+15559999", "email": "x@example.com", "job_title": "CTO"},
            }
        ],
    ).json()
    row = resp["results"][0]
    assert row["status"] == "partial"
    assert row["errors"]["phone"]["code"] == "field_not_editable"  # same answer as an unknown field
    assert row["errors"]["email"]["code"] == "field_read_only"
    assert "phone" not in row["values"]
    with in_org(org_a):
        fresh = Contact.objects.get(pk=contact.pk)
        assert fresh.phone == "+15550100" and fresh.email == "ada@example.com" and fresh.job_title == "CTO"
    # an unknown field gets the same answer as a hidden one
    unknown = _edit(client, "contact", [{"id": str(contact.pk), "version": 2, "values": {"salary": "1"}}]).json()
    assert unknown["results"][0]["errors"]["salary"]["code"] == "field_not_editable"
    # read-only system fields too
    sys_field = _edit(
        client, "contact", [{"id": str(contact.pk), "version": 2, "values": {"created_at": "2020-01-01"}}]
    )
    assert sys_field.json()["results"][0]["errors"]["created_at"]["code"] == "field_not_editable"


def test_per_cell_validation_keeps_the_other_edits(org_a, owner_client, crm):
    crm.make_custom_field(org_a, "contact", "score", label="Score", field_type="integer")
    contact = crm.make_contact(org_a)
    resp = _edit(
        owner_client,
        "contact",
        [
            {
                "id": str(contact.pk),
                "version": 1,
                "values": {
                    "email": "not-an-email",
                    "custom_data.score": "abc",
                    "job_title": "Lead",
                    "first_name": "Ada",
                },
            }
        ],
    ).json()
    row = resp["results"][0]
    assert row["status"] == "partial", row
    assert set(row["errors"]) == {"email", "custom_data.score"}
    assert row["values"]["job_title"] == "Lead"
    with in_org(org_a):
        fresh = Contact.objects.get(pk=contact.pk)
        assert fresh.job_title == "Lead" and fresh.first_name == "Ada" and "@" in fresh.email


def test_deal_stage_and_amount_cells(org_a, owner_client, crm):
    deal = crm.make_deal(org_a)
    pipeline = crm.make_pipeline(org_a)
    won = crm.stage_named(pipeline, "Won")
    resp = _edit(
        owner_client, "deal", [{"id": str(deal.pk), "version": 1, "values": {"stage": str(won.pk), "amount": "4200"}}]
    ).json()
    row = resp["results"][0]
    assert row["status"] == "saved", row
    assert row["values"]["stage"]["name"] == "Won" and row["values"]["amount"] == "4200.00"
    detail = owner_client.get(f"/api/v1/deals/{deal.pk}/").json()
    assert detail["status"] == "won" and detail["version"] == 3
    history = owner_client.get(f"/api/v1/deals/{deal.pk}/history/").json()["results"]
    assert history[0]["to_stage"]["name"] == "Won"
    # the pipeline is not editable inline
    resp = _edit(owner_client, "deal", [{"id": str(deal.pk), "version": 3, "values": {"pipeline": str(pipeline.pk)}}])
    assert resp.json()["results"][0]["errors"]["pipeline"]["code"] == "field_not_editable"


def test_edits_are_scoped_and_tenant_isolated(org_a, org_b, owner_client, make_member, client_for, crm):
    foreign = crm.make_contact(org_b)
    resp = _edit(owner_client, "contact", [{"id": str(foreign.pk), "version": 1, "values": {"job_title": "x"}}]).json()
    assert resp["results"][0]["errors"]["_row"]["code"] == "not_found"
    rep = make_member(org_a, "sales_rep")
    not_mine = crm.make_contact(org_a)  # owned by the owner: outside a rep's update scope
    rep_resp = _edit(
        client_for(rep.user, rep), "contact", [{"id": str(not_mine.pk), "version": 1, "values": {"job_title": "x"}}]
    )
    row = rep_resp.json()["results"][0]
    assert row["status"] == "error"
    with in_org(org_b):
        assert Contact.objects.get(pk=foreign.pk).job_title == ""
    assert (
        _edit(owner_client, "contact", [{"id": str(uuid.uuid4()), "version": 1, "values": {"x": 1}}] * 501).status_code
        == 400
    )


def test_windowed_fetch_over_a_large_set(org_a, owner_client, settings):
    _bulk_contacts(org_a, 5000)
    first = owner_client.get("/api/v1/records/contact/rows/?sort=first_name&limit=200&columns=first_name").json()
    assert first["total"] == 5000 and first["exact"] and len(first["rows"]) == 200
    assert first["rows"][0]["values"]["first_name"] == "Row00000"
    deep = owner_client.get(
        "/api/v1/records/contact/rows/?sort=first_name&offset=4900&limit=200&columns=first_name"
    ).json()
    assert len(deep["rows"]) == 100 and deep["rows"][0]["values"]["first_name"] == "Row04900"
    assert owner_client.get("/api/v1/records/contact/rows/?limit=5000").json()["limit"] == 500  # window is capped
    settings.SHEET_COUNT_CAP = 1000
    capped = owner_client.get("/api/v1/records/contact/rows/?limit=10").json()
    assert capped["total"] == 1000 and capped["exact"] is False
