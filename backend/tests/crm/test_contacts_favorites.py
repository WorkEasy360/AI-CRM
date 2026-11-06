"""Contacts page: personal favourites, the tag filter and the header counts (people and companies)."""

from __future__ import annotations

import pytest

from apps.core.tenancy.context import tenant_context
from apps.tagging.models import TaggedItem
from tests.factories import make_company, make_contact, make_tag

pytestmark = pytest.mark.django_db


def _star(client, entity_type, entity_id, favorite=True):
    return client.post(
        "/api/v1/favorites/",
        {"entity_type": entity_type, "entity_id": str(entity_id), "favorite": favorite},
        format="json",
    )


def test_favourites_are_personal_and_filter_the_lists(org_a, owner_client, make_member, client_for):
    rahul = make_contact(org_a, first_name="Rahul")
    make_contact(org_a, first_name="Priya")
    apex = make_company(org_a, name="Apex")
    assert _star(owner_client, "contact", rahul.pk).status_code == 200
    assert _star(owner_client, "company", apex.pk).json()["favorite"] is True

    contacts = owner_client.get("/api/v1/contacts/", {"favorite": "1"}).json()["results"]
    assert [c["id"] for c in contacts] == [str(rahul.pk)] and contacts[0]["is_favorite"] is True
    assert [c["id"] for c in owner_client.get("/api/v1/companies/", {"favorite": "1"}).json()["results"]] == [
        str(apex.pk)
    ]
    # someone else's star is not mine
    peer = make_member(org_a, "admin")
    peer_client = client_for(peer.user, peer)
    assert peer_client.get("/api/v1/contacts/", {"favorite": "1"}).json()["results"] == []
    assert all(not c["is_favorite"] for c in peer_client.get("/api/v1/contacts/").json()["results"])

    assert _star(owner_client, "contact", rahul.pk, favorite=False).json()["favorite"] is False
    assert owner_client.get("/api/v1/contacts/", {"favorite": "1"}).json()["results"] == []
    assert _star(owner_client, "deal", rahul.pk).status_code == 400


def test_favourite_needs_a_record_you_may_view(org_a, org_b, make_member, client_for, owner_client):
    foreign = make_contact(org_b)
    assert _star(owner_client, "contact", foreign.pk).status_code == 404
    hidden = make_contact(org_a)  # owned by the org owner
    rep = make_member(org_a, "sales_rep")
    assert _star(client_for(rep.user, rep), "contact", hidden.pk).status_code == 404


def test_tag_filter_and_header_counts(org_a, org_b, owner_client):
    vip = make_tag(org_a, "VIP")
    tagged = make_contact(org_a)
    make_contact(org_a)
    company = make_company(org_a)
    make_company(org_b)
    with tenant_context(org_a.org.pk):
        TaggedItem.objects.create(tag=vip, entity_type="contact", entity_id=tagged.pk)
        TaggedItem.objects.create(tag=vip, entity_type="company", entity_id=company.pk)
    assert [c["id"] for c in owner_client.get("/api/v1/contacts/", {"tag": str(vip.pk)}).json()["results"]] == [
        str(tagged.pk)
    ]
    assert owner_client.get("/api/v1/contacts/", {"tag": "x"}).status_code == 400
    _star(owner_client, "contact", tagged.pk)
    stats = owner_client.get("/api/v1/contacts/stats/").json()
    assert stats["total"] == 2 and stats["tagged"] == 1 and stats["favorites"] == 1 and stats["created"] == 2
    assert stats["companies"] == {"total": 1, "favorites": 0, "tagged": 1, "created": 1, "created_previous": 0}
