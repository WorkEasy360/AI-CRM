"""Role hierarchy ("role and subordinates" visibility), custom permission sets and field-level masking."""

from __future__ import annotations

import pytest

from apps.accounts.models import Membership
from apps.audit.models import AuditEvent
from apps.authz.models import HierarchyRole, Role
from apps.core.tenancy.context import system_context, tenant_context

pytestmark = pytest.mark.django_db

SUBORDINATE_GRANTS = {
    "org.view": "all",
    "contacts.view": "subordinates",
    "contacts.create": "all",
    "contacts.update": "subordinates",
    "deals.view": "subordinates",
}


def _profile(owner_client, name="Field sales", grants=None) -> str:
    resp = owner_client.post("/api/v1/roles/", {"name": name, "grants": grants or SUBORDINATE_GRANTS}, format="json")
    assert resp.status_code == 201, resp.content
    return resp.json()["key"]


def _member_with(bundle, make_member, role_key: str, hierarchy_role_id=None) -> Membership:
    member = make_member(bundle, "viewer")
    with tenant_context(bundle.org.pk, reason="test"):
        Membership.objects.filter(pk=member.pk).update(
            role=Role.objects.get(key=role_key), hierarchy_role_id=hierarchy_role_id
        )
        return Membership.objects.select_related("user").get(pk=member.pk)


def _hierarchy(owner_client, name, parent=None, **extra) -> str:
    body = {"name": name, "parent_id": parent, **extra}
    resp = owner_client.post("/api/v1/hierarchy-roles/", body, format="json")
    assert resp.status_code == 201, resp.content
    return resp.json()["id"]


def _names(client) -> set[str]:
    return {c["first_name"] for c in client.get("/api/v1/contacts/").json()["results"]}


# ----------------------------------------------------------------------------- hierarchy


def test_role_and_subordinates_scope_follows_the_hierarchy(org_a, owner_client, make_member, client_for, crm):
    key = _profile(owner_client)
    head = _hierarchy(owner_client, "Head of sales")
    manager_role = _hierarchy(owner_client, "Regional manager", head)
    rep_role = _hierarchy(owner_client, "Rep", manager_role)
    head_m = _member_with(org_a, make_member, key, head)
    manager = _member_with(org_a, make_member, key, manager_role)
    rep1 = _member_with(org_a, make_member, key, rep_role)
    rep2 = _member_with(org_a, make_member, key, rep_role)
    outsider = _member_with(org_a, make_member, key, None)
    for m, name in [(head_m, "Head"), (manager, "Manager"), (rep1, "Rep1"), (rep2, "Rep2"), (outsider, "Out")]:
        crm.make_contact(org_a, owner=m, first_name=name)

    assert _names(client_for(head_m.user, head_m)) == {"Head", "Manager", "Rep1", "Rep2"}
    assert _names(client_for(manager.user, manager)) == {"Manager", "Rep1", "Rep2"}
    assert _names(client_for(rep1.user, rep1)) == {"Rep1"}
    assert _names(client_for(outsider.user, outsider)) == {"Out"}

    # a record above the actor in the tree is outside the scope: 404, not 403
    with tenant_context(org_a.org.pk, reason="test"):
        from apps.contacts.models import Contact

        head_contact = Contact.objects.get(first_name="Head")
    assert client_for(manager.user, manager).get(f"/api/v1/contacts/{head_contact.pk}/").status_code == 404

    # peers see each other once the role shares with peers
    owner_client.patch(f"/api/v1/hierarchy-roles/{rep_role}/", {"share_with_peers": True}, format="json")
    assert _names(client_for(rep1.user, rep1)) == {"Rep1", "Rep2"}


def test_hierarchy_refuses_cycles_and_reparents_on_delete(org_a, owner_client, make_member):
    top = _hierarchy(owner_client, "Top")
    middle = _hierarchy(owner_client, "Middle", top)
    leaf = _hierarchy(owner_client, "Leaf", middle)
    resp = owner_client.patch(f"/api/v1/hierarchy-roles/{top}/", {"parent_id": leaf}, format="json")
    assert resp.status_code == 400 and resp.json()["type"] == "hierarchy_cycle"
    member = make_member(org_a, "sales_rep")
    resp = owner_client.post(
        "/api/v1/hierarchy-roles/assign/", {"membership_id": str(member.pk), "hierarchy_role_id": middle}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert owner_client.delete(f"/api/v1/hierarchy-roles/{middle}/").status_code == 204
    with tenant_context(org_a.org.pk, reason="test"):
        assert str(Membership.objects.get(pk=member.pk).hierarchy_role_id) == top
        assert str(HierarchyRole.objects.get(pk=leaf).parent_id) == top


def test_hierarchy_is_tenant_isolated(org_a, org_b, owner_client, client_for):
    _hierarchy(owner_client, "Only in A")
    other = client_for(org_b.owner, org_b.owner_membership)
    assert other.get("/api/v1/hierarchy-roles/").json()["results"] == []


# ----------------------------------------------------------------------------- permission sets


def test_custom_permission_sets_are_created_assigned_and_audited(org_a, owner_client, make_member, reauthenticate):
    key = _profile(owner_client, "Inside sales")
    roles = owner_client.get("/api/v1/roles/").json()
    custom = next(r for r in roles["results"] if r["key"] == key)
    assert custom["is_system"] is False and custom["grants"]["contacts.view"] == "subordinates"
    assert "subordinates" in roles["scopes"]

    member = make_member(org_a, "sales_rep")
    reauthenticate(owner_client)
    resp = owner_client.patch(f"/api/v1/members/{member.pk}/role/", {"role": key}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["role"]["key"] == key
    # in use: cannot be deleted
    assert owner_client.delete(f"/api/v1/roles/{key}/").status_code == 409
    with system_context("test"):
        assert AuditEvent.objects.filter(organization_id=org_a.org.pk, action="roles.created").exists()


def test_owner_only_permissions_and_escalation_are_refused(org_a, owner_client, make_member, client_for):
    resp = owner_client.post("/api/v1/roles/", {"name": "Finance", "grants": {"org.billing": "all"}}, format="json")
    assert resp.status_code == 400
    # a role manager limited to their own contacts cannot mint a set that sees everyone's
    key = _profile(owner_client, "Role admin", {"roles.manage": "all", "roles.view": "all", "contacts.view": "own"})
    member = _member_with(org_a, make_member, key)
    client = client_for(member.user, member)
    resp = client.post("/api/v1/roles/", {"name": "Wide", "grants": {"contacts.view": "all"}}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "grant_escalation"
    resp = client.post("/api/v1/roles/", {"name": "Narrow", "grants": {"contacts.view": "own"}}, format="json")
    assert resp.status_code == 201
    # system roles stay read-only
    assert owner_client.patch("/api/v1/roles/admin/", {"name": "Boss"}, format="json").status_code == 403


def test_sales_rep_cannot_manage_roles(org_a, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    client = client_for(rep.user, rep)
    assert client.post("/api/v1/roles/", {"name": "x", "grants": {}}, format="json").status_code == 403
    assert client.post("/api/v1/hierarchy-roles/", {"name": "x"}, format="json").status_code == 403


# ----------------------------------------------------------------------------- field-level permissions


def _restrict(owner_client, role_key, entity_type, rules):
    resp = owner_client.put(
        f"/api/v1/roles/{role_key}/field-permissions/", {"entity_type": entity_type, "rules": rules}, format="json"
    )
    assert resp.status_code == 200, resp.content


def test_hidden_and_read_only_fields_per_permission_set(org_a, owner_client, make_member, client_for, crm):
    owner_client.post(
        "/api/v1/custom-fields/",
        {"entity_type": "contact", "key": "salary", "label": "Salary", "field_type": "text"},
        format="json",
    )
    rep = make_member(org_a, "sales_rep")
    contact = crm.make_contact(org_a, owner=rep, phone="+15550100", custom_data={"salary": "90k"})
    _restrict(
        owner_client,
        "sales_rep",
        "contact",
        [
            {"field": "phone", "access": "hidden"},
            {"field": "email", "access": "read_only"},
            {"field": "custom_data.salary", "access": "hidden"},
        ],
    )
    client = client_for(rep.user, rep)
    body = client.get(f"/api/v1/contacts/{contact.pk}/").json()
    assert "phone" not in body and "email" in body and "salary" not in body["custom_data"]
    listed = client.get("/api/v1/contacts/").json()["results"][0]
    assert "phone" not in listed
    resp = client.patch(f"/api/v1/contacts/{contact.pk}/", {"email": "new@example.com", "version": 1}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "field_read_only"
    resp = client.patch(f"/api/v1/contacts/{contact.pk}/", {"phone": "+15550199", "version": 1}, format="json")
    assert resp.status_code == 403
    assert (
        client.patch(f"/api/v1/contacts/{contact.pk}/", {"job_title": "CTO", "version": 1}, format="json").status_code
        == 200
    )
    # the owner is never restricted
    full = owner_client.get(f"/api/v1/contacts/{contact.pk}/").json()
    assert full["phone"] == "+15550100" and full["custom_data"]["salary"] == "90k"


def test_hidden_deal_amount_is_masked_on_the_board(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    crm.make_deal(org_a, owner=rep, amount="5000")
    _restrict(owner_client, "sales_rep", "deal", [{"field": "amount", "access": "hidden"}])
    board = client_for(rep.user, rep).get("/api/v1/deals/board/").json()
    stages = board["stages"] if isinstance(board, dict) and "stages" in board else board["results"]
    card = next(d for s in stages for d in s["deals"])
    assert "amount" not in card and "amount_base" not in card and "weighted_amount_base" not in card
    assert all(s["total_amount_base"] is None for s in stages)


def test_owner_permission_set_cannot_be_restricted(owner_client):
    resp = owner_client.put(
        "/api/v1/roles/owner/field-permissions/",
        {"entity_type": "contact", "rules": [{"field": "phone", "access": "hidden"}]},
        format="json",
    )
    assert resp.status_code == 400


def test_protected_fields_cannot_be_restricted(owner_client):
    resp = owner_client.put(
        "/api/v1/roles/sales_rep/field-permissions/",
        {"entity_type": "contact", "rules": [{"field": "id", "access": "hidden"}]},
        format="json",
    )
    assert resp.status_code == 400


def test_field_rules_are_tenant_isolated(org_a, org_b, owner_client, make_member, client_for, crm):
    _restrict(owner_client, "sales_rep", "contact", [{"field": "phone", "access": "hidden"}])
    rep_b = make_member(org_b, "sales_rep")
    contact = crm.make_contact(org_b, owner=rep_b, phone="+15550100")
    body = client_for(rep_b.user, rep_b).get(f"/api/v1/contacts/{contact.pk}/").json()
    assert body["phone"] == "+15550100"


def test_custom_role_members_keep_their_session_and_organization_list(org_a, owner_client, make_member, client_for):
    """Regression: the identity-level session lookup joins the role; RLS must not hide custom roles there."""
    key = _profile(owner_client, "Partner managers")
    member = _member_with(org_a, make_member, key)
    body = client_for(member.user, member).get("/api/v1/session/").json()
    assert key in str(body) and str(org_a.org.pk) in str(body)


def test_admins_cannot_move_themselves_in_the_hierarchy(org_a, owner_client, make_member, client_for):
    top = _hierarchy(owner_client, "Top")
    admin = make_member(org_a, "admin")
    client = client_for(admin.user, admin)
    resp = client.post(
        "/api/v1/hierarchy-roles/assign/", {"membership_id": str(admin.pk), "hierarchy_role_id": top}, format="json"
    )
    assert resp.status_code == 403 and resp.json()["type"] == "self_placement"
    # the owner may place anyone, including themselves
    resp = owner_client.post(
        "/api/v1/hierarchy-roles/assign/", {"membership_id": str(admin.pk), "hierarchy_role_id": top}, format="json"
    )
    assert resp.status_code == 200
