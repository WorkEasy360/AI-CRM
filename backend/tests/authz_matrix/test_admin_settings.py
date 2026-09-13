"""Admin settings stay server-enforced. Hiding a page from the sidebar changes nothing on the API:
a sales representative or viewer calling an administrative endpoint directly is refused."""

from __future__ import annotations

from typing import Any

import pytest

pytestmark = pytest.mark.django_db

# (method, path, payload) -> the statuses each non-admin role must receive
ADMIN_ONLY: list[tuple[str, str, dict[str, Any] | None]] = [
    (
        "post",
        "/api/v1/custom-fields/",
        {"entity_type": "contact", "key": "tier", "label": "Tier", "field_type": "text"},
    ),
    ("post", "/api/v1/tags/", {"name": "vip"}),
    ("post", "/api/v1/pipelines/", {"name": "Partners"}),
    ("post", "/api/v1/teams/", {"name": "Field"}),
    ("post", "/api/v1/invitations/", {"email": "someone@example.com", "role": "viewer"}),
    ("get", "/api/v1/audit-events/", None),
    ("patch", "/api/v1/organizations/current/", {"name": "Renamed"}),
    ("post", "/api/v1/exports/contacts/", {"filters": {}}),
]


@pytest.fixture
def members(org_a, make_member):
    return {role: make_member(org_a, role) for role in ["sales_rep", "viewer", "admin"]}


@pytest.mark.parametrize("role", ["sales_rep", "viewer"])
@pytest.mark.parametrize(("method", "path", "payload"), ADMIN_ONLY, ids=lambda v: v if isinstance(v, str) else "")
def test_non_admin_roles_are_refused_on_admin_endpoints(
    members, client_for, reauthenticate, role, method, path, payload
):
    member = members[role]
    client = client_for(member.user, member)
    reauthenticate(client)
    resp = getattr(client, method)(path, payload, format="json") if payload is not None else client.get(path)
    assert resp.status_code == 403, (role, path, resp.content)


def test_non_admin_cannot_change_roles_or_disable_members(members, client_for, reauthenticate, org_a):
    rep = members["sales_rep"]
    target = members["viewer"]
    client = client_for(rep.user, rep)
    reauthenticate(client)
    assert client.patch(f"/api/v1/members/{target.pk}/role/", {"role": "admin"}, format="json").status_code == 403
    assert client.patch(f"/api/v1/members/{rep.pk}/role/", {"role": "owner"}, format="json").status_code == 403
    assert client.post(f"/api/v1/members/{target.pk}/disable/", {}, format="json").status_code == 403
    assert client.post(f"/api/v1/members/{org_a.owner_membership.pk}/disable/", {}, format="json").status_code == 403


def test_admin_settings_work_for_admins(members, client_for, reauthenticate):
    admin = members["admin"]
    client = client_for(admin.user, admin)
    reauthenticate(client)
    assert client.post("/api/v1/tags/", {"name": "vip"}, format="json").status_code == 201
    assert client.get("/api/v1/audit-events/").status_code == 200
    assert client.patch("/api/v1/organizations/current/", {"name": "Renamed"}, format="json").status_code == 200


def test_sales_rep_still_reads_what_the_pipeline_page_needs(members, client_for):
    """Read access needed by the everyday CRM screens is unchanged for representatives."""
    rep = members["sales_rep"]
    client = client_for(rep.user, rep)
    assert client.get("/api/v1/pipelines/").status_code == 200
    assert client.get("/api/v1/deals/board/").status_code == 200
    assert client.get("/api/v1/tags/").status_code == 200
    assert client.get("/api/v1/custom-fields/").status_code == 200
    assert client.get("/api/v1/dashboard/").status_code == 200
    assert client.get("/api/v1/organizations/current/").status_code == 200
