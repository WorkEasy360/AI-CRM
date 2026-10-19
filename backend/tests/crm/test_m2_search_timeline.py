"""Search under field permissions, and the paged, source-registered record timeline."""

from __future__ import annotations

import datetime as dt
from urllib.parse import quote

import pytest
from django.utils import timezone

from apps.notes.models import Note
from tests.m2_helpers import in_org, restrict

pytestmark = pytest.mark.django_db


def test_search_does_not_match_or_show_hidden_fields(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    crm.make_contact(org_a, owner=rep, first_name="Ada", last_name="Lovelace", phone="5550123", email="ada@example.com")
    restrict(owner_client, "sales_rep", "contact", [{"field": "phone", "access": "hidden"}])
    client = client_for(rep.user, rep)
    # the owner finds her by phone; the restricted rep cannot (that would reveal the hidden number)
    assert owner_client.get("/api/v1/search/?q=5550123&types=contact").json()["results"]["contact"]
    assert client.get("/api/v1/search/?q=5550123&types=contact").json()["results"]["contact"] == []
    by_name = client.get("/api/v1/search/?q=Lovelace&types=contact").json()["results"]["contact"]
    assert by_name and by_name[0]["subtitle"] == "ada@example.com"
    restrict(
        owner_client,
        "sales_rep",
        "contact",
        [{"field": "phone", "access": "hidden"}, {"field": "email", "access": "hidden"}],
    )
    by_name = client.get("/api/v1/search/?q=Lovelace&types=contact").json()["results"]["contact"]
    assert by_name[0]["subtitle"] == ""


def test_search_hides_deal_amounts_when_hidden(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    crm.make_deal(org_a, owner=rep, name="Zephyr upgrade", amount="9999")
    restrict(owner_client, "sales_rep", "deal", [{"field": "amount", "access": "hidden"}])
    hit = client_for(rep.user, rep).get("/api/v1/search/?q=Zephyr&types=deal").json()["results"]["deal"][0]
    assert "9999" not in hit["subtitle"]


def test_timeline_pages_by_time_and_lists_its_sources(org_a, owner_client, crm):
    contact = crm.make_contact(org_a)
    base = timezone.now() - dt.timedelta(days=30)
    with in_org(org_a):
        for i in range(12):
            note = Note.objects.create(
                entity_type="contact", entity_id=contact.pk, body=f"n{i}", author=org_a.owner_membership
            )
            Note.objects.filter(pk=note.pk).update(created_at=base + dt.timedelta(days=i))
    first = owner_client.get(
        f"/api/v1/timeline/?entity_type=contact&entity_id={contact.pk}&limit=5&sources=notes"
    ).json()
    assert [e["data"]["body"] for e in first["results"]] == ["n11", "n10", "n9", "n8", "n7"]
    assert first["next_before"]
    keys = {s["key"] for s in first["sources"]}
    assert {"notes", "activities", "files", "field_changes", "emails"} <= keys
    second = owner_client.get(
        f"/api/v1/timeline/?entity_type=contact&entity_id={contact.pk}&limit=5&sources=notes"
        f"&before={quote(first['next_before'])}"
    ).json()
    assert [e["data"]["body"] for e in second["results"]] == ["n6", "n5", "n4", "n3", "n2"]
    third = owner_client.get(
        f"/api/v1/timeline/?entity_type=contact&entity_id={contact.pk}&limit=5&sources=notes"
        f"&before={quote(second['next_before'])}"
    ).json()
    assert [e["data"]["body"] for e in third["results"]] == ["n1", "n0"] and third["next_before"] is None


def test_timeline_field_changes_hide_restricted_fields(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    contact = crm.make_contact(org_a, owner=rep)
    owner_client.patch(f"/api/v1/contacts/{contact.pk}/", {"phone": "+15550000", "version": 1}, format="json")
    restrict(owner_client, "sales_rep", "contact", [{"field": "phone", "access": "hidden"}])
    events = (
        client_for(rep.user, rep)
        .get(f"/api/v1/timeline/?entity_type=contact&entity_id={contact.pk}&sources=field_changes")
        .json()["results"]
    )
    assert all("phone" not in e["data"].get("fields", []) for e in events)
    owner_events = owner_client.get(
        f"/api/v1/timeline/?entity_type=contact&entity_id={contact.pk}&sources=field_changes"
    ).json()["results"]
    assert any("phone" in e["data"].get("fields", []) for e in owner_events)


def test_files_appear_in_the_timeline(org_a, owner_client, crm):
    deal = crm.make_deal(org_a)
    crm.make_file_attachment(org_a, record=deal)
    events = owner_client.get(f"/api/v1/timeline/?entity_type=deal&entity_id={deal.pk}").json()["results"]
    assert any(e["kind"] == "file" and e["source"] == "files" for e in events)
