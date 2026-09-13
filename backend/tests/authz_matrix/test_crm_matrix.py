"""Role x ownership x operation matrix for the CRM records, plus settings routes per role."""

from __future__ import annotations

import pytest

from apps.core.tenancy.context import tenant_context
from apps.teams.models import Team, TeamMembership

pytestmark = pytest.mark.django_db

# (role, record ownership) -> expected (retrieve, patch, archive)
RECORD_MATRIX = {
    ("owner", "own"): (200, 200, 204),
    ("owner", "other"): (200, 200, 204),
    ("admin", "own"): (200, 200, 204),
    ("admin", "other"): (200, 200, 204),
    ("sales_manager", "own"): (200, 200, 204),
    ("sales_manager", "other"): (200, 200, 204),
    ("sales_rep", "own"): (200, 200, 204),
    ("sales_rep", "team"): (200, 403, 403),
    ("sales_rep", "other"): (404, 404, 404),
    ("viewer", "own"): (200, 403, 403),
    ("viewer", "other"): (200, 403, 403),
}
MODULES = ["contacts", "companies", "deals"]


@pytest.fixture
def world(org_a, make_member):
    members = {role: make_member(org_a, role) for role in ["admin", "sales_manager", "sales_rep", "viewer"]}
    members["owner"] = org_a.owner_membership
    teammate = make_member(org_a, "sales_rep")
    outsider = make_member(org_a, "sales_rep")
    with tenant_context(org_a.org.pk):
        team = Team.objects.create(name="Reps")
        for m in [members["sales_rep"], teammate, members["viewer"], members["owner"], members["sales_manager"]]:
            TeamMembership.objects.create(team=team, membership=m)
    return {"org": org_a, "members": members, "teammate": teammate, "outsider": outsider}


def _make(crm, module, org, owner):
    if module == "contacts":
        return crm.make_contact(org, owner=owner)
    if module == "companies":
        return crm.make_company(org, owner=owner)
    return crm.make_deal(org, owner=owner)


@pytest.mark.parametrize("module", MODULES)
@pytest.mark.parametrize(("role", "ownership"), list(RECORD_MATRIX.keys()), ids=lambda v: str(v))
def test_record_matrix(world, crm, module, role, ownership, client_for):
    member = world["members"][role]
    owner_by_case = {"own": member, "team": world["teammate"], "other": world["outsider"]}
    record = _make(crm, module, world["org"], owner_by_case[ownership])
    client = client_for(member.user, member)
    expected_get, expected_patch, expected_delete = RECORD_MATRIX[(role, ownership)]
    assert client.get(f"/api/v1/{module}/{record.pk}/").status_code == expected_get
    assert (
        client.patch(
            f"/api/v1/{module}/{record.pk}/", {"name": "renamed", "first_name": "renamed", "version": 1}, format="json"
        ).status_code
        == expected_patch
    )
    assert client.delete(f"/api/v1/{module}/{record.pk}/").status_code == expected_delete


@pytest.mark.parametrize("module", MODULES)
@pytest.mark.parametrize(
    ("role", "expected"), [("owner", 201), ("admin", 201), ("sales_manager", 201), ("sales_rep", 201), ("viewer", 403)]
)
def test_record_create(world, module, role, expected, client_for):
    member = world["members"][role]
    client = client_for(member.user, member)
    payload = {"name": "n", "first_name": "n"}
    assert client.post(f"/api/v1/{module}/", payload, format="json").status_code == expected


@pytest.mark.parametrize(
    ("role", "expected"), [("owner", 201), ("admin", 201), ("sales_manager", 403), ("sales_rep", 403), ("viewer", 403)]
)
def test_product_create_by_role(world, role, expected, client_for):
    member = world["members"][role]
    client = client_for(member.user, member)
    assert client.post("/api/v1/products/", {"name": "p"}, format="json").status_code == expected
    assert client.get("/api/v1/products/").status_code == 200  # everyone reads the catalogue


SETTINGS_ROUTES = [
    ("post", "/api/v1/pipelines/", {"owner": 201, "admin": 201, "sales_manager": 201, "sales_rep": 403, "viewer": 403}),
    ("get", "/api/v1/pipelines/", {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200}),
    (
        "post",
        "/api/v1/custom-fields/",
        {"owner": 201, "admin": 201, "sales_manager": 403, "sales_rep": 403, "viewer": 403},
    ),
    (
        "get",
        "/api/v1/custom-fields/",
        {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200},
    ),
    ("post", "/api/v1/tags/", {"owner": 201, "admin": 201, "sales_manager": 201, "sales_rep": 403, "viewer": 403}),
    ("get", "/api/v1/tags/", {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200}),
    ("get", "/api/v1/search/?q=x", {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200}),
    (
        "get",
        "/api/v1/exports/contacts/",
        {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 403, "viewer": 403},
    ),
    (
        "get",
        "/api/v1/imports/contacts/",
        {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 403, "viewer": 403},
    ),
    (
        "get",
        "/api/v1/imports/products/",
        {"owner": 200, "admin": 200, "sales_manager": 403, "sales_rep": 403, "viewer": 403},
    ),
    (
        "post",
        "/api/v1/contacts/bulk/",
        {"owner": 400, "admin": 400, "sales_manager": 400, "sales_rep": 403, "viewer": 403},
    ),
    (
        "get",
        "/api/v1/deals/board/",
        {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200},
    ),
    (
        "post",
        "/api/v1/activities/",
        {"owner": 201, "admin": 201, "sales_manager": 201, "sales_rep": 201, "viewer": 403},
    ),
    ("get", "/api/v1/activities/", {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200}),
    (
        "get",
        "/api/v1/notifications/",
        {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200},
    ),
    ("get", "/api/v1/forecast/", {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200}),
    (
        "post",
        "/api/v1/email/templates/",
        {"owner": 201, "admin": 201, "sales_manager": 201, "sales_rep": 403, "viewer": 403},
    ),
    (
        "get",
        "/api/v1/email/accounts/",
        {"owner": 200, "admin": 200, "sales_manager": 200, "sales_rep": 200, "viewer": 200},
    ),
    (
        "post",
        "/api/v1/whatsapp/templates/",
        {"owner": 201, "admin": 201, "sales_manager": 403, "sales_rep": 403, "viewer": 403},
    ),
    (
        "post",
        "/api/v1/ai/follow-up/",
        {"owner": 400, "admin": 400, "sales_manager": 400, "sales_rep": 400, "viewer": 403},
    ),
    ("get", "/api/v1/ai/usage/", {"owner": 200, "admin": 200, "sales_manager": 403, "sales_rep": 403, "viewer": 403}),
]


@pytest.mark.parametrize("role", ["owner", "admin", "sales_manager", "sales_rep", "viewer"])
@pytest.mark.parametrize(
    ("method", "path", "expectations"), SETTINGS_ROUTES, ids=lambda v: v if isinstance(v, str) else ""
)
def test_settings_routes_by_role(world, role, method, path, expectations, client_for):
    member = world["members"][role]
    client = client_for(member.user, member)
    payload = {}
    if path.endswith("/pipelines/"):
        payload = {"name": f"pipe-{role}"}
    elif path.endswith("/custom-fields/"):
        payload = {"entity_type": "contact", "key": f"f_{role}", "label": "F", "field_type": "text"}
    elif path.endswith("/tags/"):
        payload = {"name": f"tag-{role}"}
    elif path.endswith("/bulk/"):
        payload = {"ids": ["00000000-0000-0000-0000-000000000001"], "action": "archive"}
    elif path.endswith("/activities/"):
        payload = {"kind": "task", "title": f"task-{role}"}
    elif path.endswith("/email/templates/"):
        payload = {"name": f"tpl-{role}", "body": "Hi"}
    elif path.endswith("/whatsapp/templates/"):
        payload = {"name": f"tpl_{role}", "body": "Hi"}
    resp = getattr(client, method)(path, payload, format="json") if method != "get" else client.get(path)
    assert resp.status_code == expectations[role], resp.content


def test_reassignment_rules(world, crm, client_for):
    """Only actors with update:all (or deals.reassign) may hand records to other members."""
    rep, manager, outsider = world["members"]["sales_rep"], world["members"]["sales_manager"], world["outsider"]
    repc = client_for(rep.user, rep)
    resp = repc.post("/api/v1/contacts/", {"first_name": "x", "owner_id": str(outsider.pk)}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "reassign_denied"
    resp = repc.post("/api/v1/contacts/", {"first_name": "x", "owner_id": str(rep.pk)}, format="json")
    assert resp.status_code == 201
    own = crm.make_contact(world["org"], owner=rep)
    assert (
        repc.patch(
            f"/api/v1/contacts/{own.pk}/", {"owner_id": str(outsider.pk), "version": 1}, format="json"
        ).status_code
        == 403
    )
    mgr = client_for(manager.user, manager)
    resp = mgr.patch(f"/api/v1/contacts/{own.pk}/", {"owner_id": str(outsider.pk), "version": 1}, format="json")
    assert resp.status_code == 200 and resp.json()["owner"]["id"] == str(outsider.pk)
    deal = crm.make_deal(world["org"], owner=rep)
    assert (
        repc.patch(f"/api/v1/deals/{deal.pk}/", {"owner_id": str(outsider.pk), "version": 1}, format="json").status_code
        == 403
    )
    assert (
        mgr.patch(f"/api/v1/deals/{deal.pk}/", {"owner_id": str(outsider.pk), "version": 1}, format="json").status_code
        == 200
    )
