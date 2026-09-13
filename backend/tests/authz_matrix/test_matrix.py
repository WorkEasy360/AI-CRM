"""Role x ownership x operation matrix against an owned tenant resource, plus admin endpoints per role."""

from __future__ import annotations

import pytest

from apps.core.tenancy.context import tenant_context
from apps.teams.models import Team, TeamMembership

pytestmark = pytest.mark.django_db

# (role, record ownership) -> expected (retrieve, update, delete)
MATRIX = {
    ("owner", "own"): (200, 200, 204),
    ("owner", "team"): (200, 200, 204),
    ("owner", "other"): (200, 200, 204),
    ("admin", "own"): (200, 200, 204),
    ("admin", "other"): (200, 200, 204),
    ("sales_manager", "own"): (200, 200, 204),
    ("sales_manager", "team"): (200, 200, 204),
    ("sales_manager", "other"): (200, 200, 204),
    ("sales_rep", "own"): (200, 200, 204),
    ("sales_rep", "team"): (200, 403, 403),
    ("sales_rep", "other"): (404, 404, 404),
    ("viewer", "own"): (200, 403, 403),
    ("viewer", "other"): (200, 403, 403),
}


@pytest.fixture
def world(org_a, make_member, make_widget):
    """One member per role, a teammate sharing a team with the sales rep, and an unrelated member."""
    members = {role: make_member(org_a, role) for role in ["admin", "sales_manager", "sales_rep", "viewer"]}
    members["owner"] = org_a.owner_membership
    teammate = make_member(org_a, "sales_rep")
    outsider = make_member(org_a, "sales_rep")
    with tenant_context(org_a.org.pk):
        team = Team.objects.create(name="Reps")
        for m in [members["sales_rep"], teammate, members["viewer"], members["owner"], members["sales_manager"]]:
            TeamMembership.objects.create(team=team, membership=m)
    return {"org": org_a, "members": members, "teammate": teammate, "outsider": outsider}


@pytest.mark.parametrize(("role", "ownership"), list(MATRIX.keys()), ids=lambda v: str(v))
def test_widget_matrix(world, role, ownership, client_for, make_widget):
    member = world["members"][role]
    owner_by_case = {"own": member, "team": world["teammate"], "other": world["outsider"]}
    widget = make_widget(world["org"], owner=owner_by_case[ownership])
    client = client_for(member.user, member)
    expected_get, expected_patch, expected_delete = MATRIX[(role, ownership)]

    assert client.get(f"/api/v1/widgets/{widget.pk}/").status_code == expected_get
    assert (
        client.patch(f"/api/v1/widgets/{widget.pk}/", {"name": "renamed"}, format="json").status_code == expected_patch
    )
    assert client.delete(f"/api/v1/widgets/{widget.pk}/").status_code == expected_delete


@pytest.mark.parametrize(
    ("role", "expected"), [("owner", 201), ("admin", 201), ("sales_manager", 201), ("sales_rep", 201), ("viewer", 403)]
)
def test_widget_create(world, role, expected, client_for):
    member = world["members"][role]
    client = client_for(member.user, member)
    assert client.post("/api/v1/widgets/", {"name": "n"}, format="json").status_code == expected


ADMIN_ROUTES = [
    ("get", "/api/v1/members/", {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200}),
    (
        "get",
        "/api/v1/invitations/",
        {"owner": 200, "admin": 200, "sales_manager": 403, "sales_rep": 403, "viewer": 403},
    ),
    (
        "post",
        "/api/v1/invitations/",
        {"owner": 201, "admin": 201, "sales_manager": 403, "sales_rep": 403, "viewer": 403},
    ),
    (
        "get",
        "/api/v1/audit-events/",
        {"owner": 200, "admin": 200, "sales_manager": 403, "sales_rep": 403, "viewer": 403},
    ),
    ("get", "/api/v1/teams/", {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200}),
    ("post", "/api/v1/teams/", {"owner": 201, "admin": 201, "sales_manager": 403, "sales_rep": 403, "viewer": 403}),
    (
        "patch",
        "/api/v1/organizations/current/",
        {"owner": 200, "admin": 200, "sales_manager": 403, "sales_rep": 403, "viewer": 403},
    ),
    ("get", "/api/v1/roles/", {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200}),
]


@pytest.mark.parametrize("role", ["owner", "admin", "sales_manager", "sales_rep", "viewer"])
@pytest.mark.parametrize(
    ("method", "path", "expectations"), ADMIN_ROUTES, ids=lambda v: v if isinstance(v, str) else ""
)
def test_admin_routes_by_role(world, role, method, path, expectations, client_for, reauthenticate):
    member = world["members"][role]
    client = client_for(member.user, member)
    reauthenticate(client)
    payload = {}
    if path.endswith("/invitations/"):
        payload = {"email": f"{role}-invitee@example.com", "role": "viewer"}
    elif path.endswith("/teams/"):
        payload = {"name": f"team-{role}"}
    elif path.endswith("/organizations/current/"):
        payload = {"name": "Renamed"}
    resp = getattr(client, method)(path, payload, format="json")
    assert resp.status_code == expectations[role], resp.content


def test_anonymous_is_denied_everywhere(anon_client):
    for path in [
        "/api/v1/session/",
        "/api/v1/members/",
        "/api/v1/teams/",
        "/api/v1/audit-events/",
        "/api/v1/widgets/",
        "/api/v1/organizations/current/",
        "/api/v1/roles/",
    ]:
        resp = anon_client.get(path)
        assert resp.status_code in (401, 403), path
        assert "traceback" not in resp.content.decode().lower()


def test_user_without_active_org_is_denied_tenant_routes(make_user, client_for):
    user = make_user()
    client = client_for(user)
    assert client.get("/api/v1/session/").status_code == 200
    for path in ["/api/v1/members/", "/api/v1/teams/", "/api/v1/widgets/"]:
        assert client.get(path).status_code == 403
