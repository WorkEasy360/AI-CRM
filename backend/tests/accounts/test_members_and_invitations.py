"""Invitations, role changes and member disabling: invariants and escalation attempts."""

from __future__ import annotations

import pytest
from django.core import mail
from rest_framework.test import APIClient

from apps.accounts.models import Membership
from apps.core.tenancy.context import tenant_context
from tests.accounts.conftest import AUTH
from tests.conftest import extract_link_key
from tests.factories import DEFAULT_PASSWORD

pytestmark = pytest.mark.django_db


def _invite(client, email, role="sales_rep"):
    resp = client.post("/api/v1/invitations/", {"email": email, "role": role}, format="json")
    assert resp.status_code == 201, resp.content
    token = extract_link_key(mail.outbox[-1].body, "token=")
    return resp.json(), token


def test_invite_and_accept_creates_membership(org_a, owner_client, make_user):
    invitee = make_user("invitee@example.com")
    data, token = _invite(owner_client, "Invitee@Example.com")
    assert data["status"] == "pending"
    assert "token" not in data

    preview = APIClient().get(f"/api/v1/invitations/preview/?token={token}")
    assert preview.status_code == 200
    assert preview.json()["organization_name"] == "Org A"

    client = APIClient()
    assert (
        client.post(AUTH + "login", {"email": invitee.email, "password": DEFAULT_PASSWORD}, format="json").status_code
        == 200
    )
    resp = client.post("/api/v1/invitations/accept/", {"token": token}, format="json")
    assert resp.status_code == 200
    session = client.get("/api/v1/session/").json()
    assert session["active"]["organization"]["name"] == "Org A"
    assert session["active"]["role"]["key"] == "sales_rep"

    # single use
    assert client.post("/api/v1/invitations/accept/", {"token": token}, format="json").status_code == 404
    assert APIClient().get(f"/api/v1/invitations/preview/?token={token}").status_code == 404


def test_accept_requires_matching_email(org_a, owner_client, make_user, client_for):
    _, token = _invite(owner_client, "someone@example.com")
    other = make_user("other@example.com")
    client = client_for(other)
    resp = client.post("/api/v1/invitations/accept/", {"token": token}, format="json")
    assert resp.status_code == 403
    assert resp.json()["type"] == "invitation_email_mismatch"


def test_accept_requires_authentication(org_a, owner_client):
    _, token = _invite(owner_client, "someone@example.com")
    assert APIClient().post("/api/v1/invitations/accept/", {"token": token}, format="json").status_code in (401, 403)


def test_invalid_or_revoked_token(org_a, owner_client, make_user, client_for):
    data, token = _invite(owner_client, "someone@example.com")
    assert owner_client.delete(f"/api/v1/invitations/{data['id']}/").status_code == 204
    user = make_user("someone@example.com")
    client = client_for(user)
    assert client.post("/api/v1/invitations/accept/", {"token": token}, format="json").status_code == 404
    assert client.post("/api/v1/invitations/accept/", {"token": "garbage"}, format="json").status_code == 404


def test_admin_cannot_invite_owner(org_a, make_member, client_for):
    admin = make_member(org_a, "admin")
    client = client_for(admin.user, admin)
    resp = client.post("/api/v1/invitations/", {"email": "x@example.com", "role": "owner"}, format="json")
    assert resp.status_code == 403


def test_existing_member_cannot_be_invited_again(org_a, owner_client, make_member):
    member = make_member(org_a)
    resp = owner_client.post("/api/v1/invitations/", {"email": member.user.email, "role": "viewer"}, format="json")
    assert resp.status_code == 409


def test_role_change_requires_recent_auth(org_a, owner_client, make_member, reauthenticate):
    member = make_member(org_a, "sales_rep")
    resp = owner_client.patch(f"/api/v1/members/{member.pk}/role/", {"role": "sales_manager"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["type"] == "reauth_required"
    reauthenticate(owner_client)
    resp = owner_client.patch(f"/api/v1/members/{member.pk}/role/", {"role": "sales_manager"}, format="json")
    assert resp.status_code == 200
    assert resp.json()["role"]["key"] == "sales_manager"


def test_role_change_revokes_target_sessions(org_a, owner_client, make_member, client_for, reauthenticate):
    member = make_member(org_a, "sales_rep")
    target_client = client_for(member.user, member)
    assert target_client.get("/api/v1/session/").status_code == 200
    reauthenticate(owner_client)
    assert (
        owner_client.patch(f"/api/v1/members/{member.pk}/role/", {"role": "viewer"}, format="json").status_code == 200
    )
    assert target_client.get("/api/v1/session/").status_code in (401, 403)


def test_cannot_change_own_role(org_a, owner_client, reauthenticate):
    reauthenticate(owner_client)
    resp = owner_client.patch(f"/api/v1/members/{org_a.owner_membership.pk}/role/", {"role": "viewer"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["type"] == "self_role_change"


def test_admin_cannot_modify_owner_or_grant_owner(org_a, make_member, client_for, reauthenticate):
    admin = make_member(org_a, "admin")
    rep = make_member(org_a, "sales_rep")
    client = client_for(admin.user, admin)
    reauthenticate(client)
    assert (
        client.patch(
            f"/api/v1/members/{org_a.owner_membership.pk}/role/", {"role": "viewer"}, format="json"
        ).status_code
        == 403
    )
    assert client.post(f"/api/v1/members/{org_a.owner_membership.pk}/disable/", {}, format="json").status_code == 403
    assert client.patch(f"/api/v1/members/{rep.pk}/role/", {"role": "owner"}, format="json").status_code == 403
    assert client.patch(f"/api/v1/members/{rep.pk}/role/", {"role": "admin"}, format="json").status_code == 200


def test_last_owner_is_protected(org_a, make_member, client_for, reauthenticate):
    second_owner = make_member(org_a, "owner")
    client = client_for(second_owner.user, second_owner)
    reauthenticate(client)
    # demote the original owner: allowed while a second owner exists
    assert (
        client.patch(f"/api/v1/members/{org_a.owner_membership.pk}/role/", {"role": "admin"}, format="json").status_code
        == 200
    )
    # the second owner is now the last one; the original (now admin) cannot touch them
    admin_client = client_for(org_a.owner, org_a.owner_membership)
    reauthenticate(admin_client)
    assert (
        admin_client.patch(f"/api/v1/members/{second_owner.pk}/role/", {"role": "viewer"}, format="json").status_code
        == 403
    )
    # a third owner may disable the second owner because they themselves remain an active owner
    third = make_member(org_a, "owner")
    third_client = client_for(third.user, third)
    reauthenticate(third_client)
    assert third_client.post(f"/api/v1/members/{second_owner.pk}/disable/", {}, format="json").status_code == 200
    # now 'third' is the last owner and cannot be demoted by anyone including another owner promoted later
    with tenant_context(org_a.org.pk):
        assert Membership.objects.active().filter(role__key="owner").count() == 1


def test_disable_member_revokes_sessions_and_blocks_access(
    org_a, owner_client, make_member, client_for, reauthenticate
):
    member = make_member(org_a, "viewer")
    target = client_for(member.user, member)
    assert target.get("/api/v1/members/").status_code == 200
    reauthenticate(owner_client)
    resp = owner_client.post(f"/api/v1/members/{member.pk}/disable/", {}, format="json")
    assert resp.status_code == 200 and resp.json()["status"] == "disabled"
    assert target.get("/api/v1/members/").status_code in (401, 403)
    # even with a fresh login, the disabled membership does not resolve to an organization
    fresh = client_for(member.user, member)
    assert fresh.get("/api/v1/session/").json()["active"] is None
    assert owner_client.post(f"/api/v1/members/{member.pk}/enable/", {}, format="json").status_code == 200


def test_org_update_requires_recent_auth_and_validates(org_a, owner_client, reauthenticate):
    assert owner_client.patch("/api/v1/organizations/current/", {"name": "New"}, format="json").status_code == 403
    reauthenticate(owner_client)
    assert (
        owner_client.patch("/api/v1/organizations/current/", {"base_currency": "rupees"}, format="json").status_code
        == 400
    )
    assert (
        owner_client.patch("/api/v1/organizations/current/", {"timezone": "Mars/Olympus"}, format="json").status_code
        == 400
    )
    resp = owner_client.patch(
        "/api/v1/organizations/current/", {"name": "New", "base_currency": "usd", "require_mfa": True}, format="json"
    )
    assert resp.status_code == 200
    assert resp.json()["base_currency"] == "USD"
    assert resp.json()["require_mfa"] is True
