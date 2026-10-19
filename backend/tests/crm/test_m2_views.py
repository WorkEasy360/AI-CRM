"""Milestone 2 views: the module schema, saved views (sharing, defaults, field rules) and the generic List,
Kanban, Calendar and Chart reads, under a restrictive profile and a role-hierarchy user."""

from __future__ import annotations

import pytest

from apps.audit.models import AuditEvent
from apps.teams.models import TeamMembership
from tests.m2_helpers import in_org, manager_and_reps, restrict

pytestmark = pytest.mark.django_db

KINDS = ("list", "kanban", "sheet", "calendar", "chart")
CONFIG = {
    "contact": {
        "list": {},
        "sheet": {},
        "kanban": {"group_by": "lifecycle_stage"},
        "calendar": {"date_field": "created_at"},
        "chart": {"group_by": "lifecycle_stage", "measure": "count"},
    },
    "deal": {
        "list": {},
        "sheet": {},
        "kanban": {"group_by": "stage"},
        "calendar": {"date_field": "expected_close_date"},
        "chart": {"group_by": "stage", "measure": "sum", "field": "amount"},
    },
}


def test_schema_describes_modules_and_applies_field_rules(org_a, owner_client, make_member, client_for, crm):
    modules = {m["entity_type"] for m in owner_client.get("/api/v1/records/").json()["results"]}
    assert {"contact", "company", "deal", "product"} <= modules
    crm.make_custom_field(org_a, "contact", "region", label="Region", field_type="dropdown", options=["N", "S"])
    full = {f["key"]: f for f in owner_client.get("/api/v1/records/contact/schema/").json()["fields"]}
    assert full["custom_data.region"]["type"] == "choice" and full["custom_data.region"]["choices"] == ["N", "S"]
    assert full["email"]["editable"] and full["created_at"]["editable"] is False
    rep = make_member(org_a, "sales_rep")
    restrict(
        owner_client,
        "sales_rep",
        "contact",
        [{"field": "phone", "access": "hidden"}, {"field": "email", "access": "read_only"}],
    )
    mine = {f["key"]: f for f in client_for(rep.user, rep).get("/api/v1/records/contact/schema/").json()["fields"]}
    assert "phone" not in mine and mine["email"]["read_only"] and not mine["email"]["editable"]


@pytest.mark.parametrize("entity_type", ["contact", "deal"])
@pytest.mark.parametrize("kind", KINDS)
def test_all_five_views_save_and_open(org_a, owner_client, crm, entity_type, kind):
    """Acceptance: all five views work on Contacts and Deals, saved and shared."""
    contact = crm.make_contact(org_a, first_name="Ada", lifecycle_stage="lead")
    crm.make_deal(
        org_a, name="Big one", amount="5000", amount_base="5000", contact=contact, expected_close_date="2026-11-20"
    )
    body = {
        "entity_type": entity_type,
        "name": f"My {kind}",
        "kind": kind,
        "columns": ["owner"],
        "config": CONFIG[entity_type][kind],
        "visibility": "organization",
    }
    resp = owner_client.post("/api/v1/views/", body, format="json")
    assert resp.status_code == 201, resp.content
    view = resp.json()
    assert view["is_owner"] and view["visibility"] == "organization"
    # open it the way the client does
    base = f"/api/v1/records/{entity_type}"
    if kind in {"list", "sheet"}:
        data = owner_client.get(f"{base}/rows/?columns=owner").json()
        assert data["total"] >= 1 and data["rows"][0]["values"]["owner"]
    elif kind == "kanban":
        data = owner_client.get(f"{base}/groups/?group_by={view['config']['group_by']}").json()
        assert sum(g["count"] for g in data["groups"]) >= 1
    elif kind == "calendar":
        data = owner_client.get(
            f"{base}/calendar/?date_field={view['config']['date_field']}&from=2026-10-01&to=2026-12-31"
        ).json()
        assert data["items"]
    else:
        q = "&".join(f"{k}={v}" for k, v in view["config"].items())
        data = owner_client.get(f"{base}/chart/?{q}").json()
        assert data["series"]


def test_view_validation(owner_client):
    bad_filter = owner_client.post(
        "/api/v1/views/",
        {"entity_type": "deal", "name": "x", "kind": "list", "filters": {"no_such_filter": "1"}},
        format="json",
    )
    assert bad_filter.status_code == 400
    bad_column = owner_client.post(
        "/api/v1/views/", {"entity_type": "deal", "name": "x", "kind": "list", "columns": ["nope"]}, format="json"
    )
    assert bad_column.status_code == 400
    bad_group = owner_client.post(
        "/api/v1/views/",
        {"entity_type": "deal", "name": "x", "kind": "kanban", "config": {"group_by": "amount"}},
        format="json",
    )
    assert bad_group.status_code == 400
    ok = owner_client.post(
        "/api/v1/views/",
        {
            "entity_type": "deal",
            "name": "Open big",
            "kind": "list",
            "filters": {"status": "open", "amount_min": "1000"},
        },
        format="json",
    )
    assert ok.status_code == 201
    dup = owner_client.post(
        "/api/v1/views/", {"entity_type": "deal", "name": "Open big", "kind": "list"}, format="json"
    )
    assert dup.status_code == 409


def test_sharing_visibility_and_defaults(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    teammate = make_member(org_a, "sales_rep")
    stranger = make_member(org_a, "sales_rep")
    team = crm.make_team(org_a, "North")
    with in_org(org_a):
        TeamMembership.objects.create(team=team, membership=teammate)
    rep_client = client_for(rep.user, rep)
    # a rep may save private views but not share them
    private = rep_client.post(
        "/api/v1/views/", {"entity_type": "contact", "name": "Mine", "kind": "list"}, format="json"
    )
    assert private.status_code == 201
    assert (
        rep_client.post(
            "/api/v1/views/",
            {"entity_type": "contact", "name": "Shared", "kind": "list", "visibility": "organization"},
            format="json",
        ).status_code
        == 403
    )
    team_view = owner_client.post(
        "/api/v1/views/",
        {
            "entity_type": "contact",
            "name": "North leads",
            "kind": "list",
            "visibility": "teams",
            "team_ids": [str(team.pk)],
        },
        format="json",
    ).json()

    def names(client):
        return {v["name"] for v in client.get("/api/v1/views/?entity_type=contact").json()["results"]}

    assert names(client_for(teammate.user, teammate)) == {"North leads"}
    assert names(client_for(stranger.user, stranger)) == set()
    assert names(rep_client) == {"Mine"}
    # only the owner may change it
    mate = client_for(teammate.user, teammate)
    assert mate.patch(f"/api/v1/views/{team_view['id']}/", {"name": "Hijack"}, format="json").status_code == 403
    assert mate.delete(f"/api/v1/views/{team_view['id']}/").status_code == 403
    # per-member default
    assert mate.post(f"/api/v1/views/{team_view['id']}/default/").status_code == 200
    listed = mate.get("/api/v1/views/?entity_type=contact").json()["results"]
    assert listed[0]["is_default"] is True
    assert owner_client.get("/api/v1/views/?entity_type=contact").json()["results"][0]["is_default"] is False
    assert mate.post("/api/v1/views/default/clear/", {"entity_type": "contact"}, format="json").status_code == 204
    # someone else's private view is invisible (404), even by id
    assert mate.get(f"/api/v1/views/{private.json()['id']}/").status_code == 404
    with in_org(org_a):
        assert AuditEvent.objects.filter(action="views.created").count() == 2
        assert AuditEvent.objects.filter(action="views.default_set").exists()


def test_shared_view_drops_what_the_viewer_cannot_see(org_a, owner_client, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    view = owner_client.post(
        "/api/v1/views/",
        {
            "entity_type": "deal",
            "name": "Pipeline value",
            "kind": "list",
            "columns": ["name", "amount", "stage"],
            "filters": {"amount_min": "1000"},
            "sort": "-amount",
            "visibility": "organization",
        },
        format="json",
    ).json()
    restrict(owner_client, "sales_rep", "deal", [{"field": "amount", "access": "hidden"}])
    seen = client_for(rep.user, rep).get(f"/api/v1/views/{view['id']}/").json()
    assert seen["columns"] == ["name", "stage"] and seen["filters"] == {} and seen["sort"] == ""
    assert seen["restricted"] is True


def test_hidden_fields_are_absent_from_every_view(org_a, owner_client, make_member, client_for, crm):
    """Acceptance: a hidden field is absent from the payload and from every view."""
    rep = make_member(org_a, "sales_rep")
    crm.make_deal(org_a, owner=rep, amount="777", amount_base="777", expected_close_date="2026-11-03")
    restrict(owner_client, "sales_rep", "deal", [{"field": "amount", "access": "hidden"}])
    c = client_for(rep.user, rep)
    rows = c.get("/api/v1/records/deal/rows/?columns=name,amount,amount_base,weighted_amount_base").json()
    assert {col["key"] for col in rows["columns"]} == {"name"}
    assert "amount" not in rows["rows"][0]["values"]
    groups = c.get("/api/v1/records/deal/groups/?group_by=stage&columns=name,amount").json()
    assert all("amount" not in r["values"] for g in groups["groups"] for r in g["rows"])
    cal = c.get(
        "/api/v1/records/deal/calendar/?date_field=expected_close_date&from=2026-11-01&to=2026-11-30&columns=amount"
    ).json()
    assert cal["items"] and "amount" not in cal["items"][0]["values"]
    assert c.get("/api/v1/records/deal/chart/?group_by=stage&measure=sum&field=amount").status_code == 400
    # filters and sorts on the hidden field are refused like unknown ones (no oracle)
    assert c.get("/api/v1/deals/?amount_min=500").status_code == 400
    assert c.get("/api/v1/deals/?sort=amount").status_code == 400
    assert c.get("/api/v1/records/deal/rows/?amount_min=500").status_code == 400
    assert "amount" not in c.get("/api/v1/deals/").json()["results"][0]


def test_hierarchy_user_sees_own_and_subordinates_in_every_view(org_a, owner_client, make_member, client_for, crm):
    """Acceptance: a hierarchy user sees only own + subordinates across lists, views, search and aggregates."""
    manager, rep1, rep2, outsider = manager_and_reps(org_a, owner_client, make_member)
    for m, name in [(manager, "Mgr"), (rep1, "Rep1"), (rep2, "Rep2"), (outsider, "Out")]:
        crm.make_contact(org_a, owner=m, first_name=name, last_name="Zebra", lifecycle_stage="lead")
        crm.make_deal(
            org_a, owner=m, name=f"{name} deal", amount="100", amount_base="100", expected_close_date="2026-11-10"
        )
    expected = {"Mgr", "Rep1", "Rep2"}

    def check(client, want):
        rows = client.get("/api/v1/records/contact/rows/?columns=first_name&limit=50").json()
        assert {r["values"]["first_name"] for r in rows["rows"]} == want and rows["total"] == len(want)
        groups = client.get("/api/v1/records/contact/groups/?group_by=lifecycle_stage&columns=first_name").json()
        assert sum(g["count"] for g in groups["groups"]) == len(want)
        chart = client.get("/api/v1/records/deal/chart/?group_by=owner&measure=sum&field=amount").json()
        assert sum(float(p["value"]) for p in chart["series"]) == 100.0 * len(want)
        cal = client.get(
            "/api/v1/records/deal/calendar/?date_field=expected_close_date&from=2026-11-01&to=2026-11-30&columns=name"
        ).json()
        assert {i["values"]["name"] for i in cal["items"]} == {f"{n} deal" for n in want}
        found = client.get("/api/v1/search/?q=Zebra&types=contact&limit=20").json()["results"]["contact"]
        assert {r["title"].split()[0] for r in found} == want
        board = client.get("/api/v1/deals/board/").json()
        assert sum(s["deal_count"] for s in board["stages"]) == len(want)

    check(client_for(manager.user, manager), expected)
    check(client_for(rep1.user, rep1), {"Rep1"})
    check(client_for(outsider.user, outsider), {"Out"})


def test_views_and_record_reads_are_tenant_isolated(org_a, org_b, owner_client, client_for, crm):
    other = client_for(org_b.owner, org_b.owner_membership)
    view = owner_client.post(
        "/api/v1/views/", {"entity_type": "contact", "name": "A", "kind": "list"}, format="json"
    ).json()
    assert other.get(f"/api/v1/views/{view['id']}/").status_code == 404
    assert other.post(f"/api/v1/views/{view['id']}/default/").status_code == 404
    assert other.get("/api/v1/views/").json()["results"] == []
    crm.make_contact(org_a, first_name="OnlyA")
    rows = other.get("/api/v1/records/contact/rows/?columns=first_name").json()["rows"]
    assert all(r["values"]["first_name"] != "OnlyA" for r in rows)
    groups = other.get("/api/v1/records/contact/groups/?group_by=lifecycle_stage").json()["groups"]
    assert sum(g["count"] for g in groups) == 0
