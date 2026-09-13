"""Client-supplied organization/owner identifiers never influence tenant or ownership decisions."""

import pytest

from apps.core.tenancy.context import tenant_context
from tests.testapp.models import Widget

pytestmark = pytest.mark.django_db


def test_organization_id_in_payload_is_ignored(org_a, org_b, owner_client):
    resp = owner_client.post(
        "/api/v1/widgets/",
        {"name": "w", "organization": str(org_b.org.pk), "organization_id": str(org_b.org.pk)},
        format="json",
    )
    assert resp.status_code == 201
    with tenant_context(org_a.org.pk):
        assert Widget.objects.filter(pk=resp.json()["id"]).exists()
    with tenant_context(org_b.org.pk):
        assert not Widget.objects.filter(pk=resp.json()["id"]).exists()


def test_owner_id_in_payload_is_ignored(org_a, org_b, owner_client, make_member):
    other = make_member(org_a)
    resp = owner_client.post("/api/v1/widgets/", {"name": "w", "owner_id": str(other.pk)}, format="json")
    assert resp.status_code == 201
    assert resp.json()["owner_id"] == str(org_a.owner_membership.pk)


def test_foreign_key_smuggling_rejected(org_a, org_b, owner_client, make_member):
    """A membership id from another organization does not validate as a team manager."""
    foreign_member = make_member(org_b)
    resp = owner_client.post("/api/v1/teams/", {"name": "T", "manager_id": str(foreign_member.pk)}, format="json")
    assert resp.status_code == 400
    assert any(e["field"] == "manager_id" for e in resp.json()["errors"])


def test_session_membership_from_other_user_is_rejected(org_a, org_b, client_for):
    """A tampered session pointing at another user's membership yields no organization."""
    client = client_for(org_a.owner, org_b.owner_membership)
    resp = client.get("/api/v1/session/")
    assert resp.status_code == 200
    assert resp.json()["active"] is None
    resp = client.get("/api/v1/members/")
    assert resp.status_code == 403
