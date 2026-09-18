"""User management: invitation sign-up, resend, suspend / reactivate / remove, sessions, teams, seat limits.

Security invariants covered here (see also test_members_and_invitations.py):
- only members.invite holders invite, and nobody grants a role above their own
- organization, role and team come from the invitation row; forged request fields are ignored
- invitation tokens are single use, expire, and survive concurrent use exactly once
- removal and suspension cut access immediately; removal is reversible only by a new invitation
"""

from __future__ import annotations

import threading
from datetime import timedelta

import pytest
from allauth.account.models import EmailAddress
from allauth.mfa.models import Authenticator
from django.core import mail
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts import services
from apps.accounts.models import Invitation, Membership, Organization, User
from apps.audit.models import AuditEvent
from apps.core.exceptions import DomainError
from apps.core.tenancy.context import system_context, tenant_context
from apps.teams.models import Team, TeamMembership
from tests.conftest import extract_link_key
from tests.factories import DEFAULT_PASSWORD

pytestmark = pytest.mark.django_db

NEW_PASSWORD = "Invited-Str0ng-Passw0rd!"


def _invite(client, email, role="sales_rep", **extra):
    resp = client.post("/api/v1/invitations/", {"email": email, "role": role, **extra}, format="json")
    assert resp.status_code == 201, resp.content
    return resp.json(), extract_link_key(mail.outbox[-1].body, "token=")


def _register(client, token, name="Ada Lovelace", password=NEW_PASSWORD, **extra):
    return client.post(
        "/api/v1/invitations/register/", {"token": token, "name": name, "password": password, **extra}, format="json"
    )


def _audit(action: str, **filters) -> list[AuditEvent]:
    with system_context("test.audit"):
        return list(AuditEvent.objects.filter(action=action, **filters))


def _team(org, name="Enterprise"):
    with tenant_context(org.org.pk, reason="test.team"):
        return Team.objects.create(name=name)


# ----------------------------------------------------------------------------- invitation sign-up


def test_invitee_creates_account_from_link_and_lands_in_crm(org_a, owner_client):
    team = _team(org_a)
    _, token = _invite(owner_client, "new.person@example.com", name="New Person", team_id=str(team.pk))

    preview = APIClient().get(f"/api/v1/invitations/preview/?token={token}").json()
    assert preview["name"] == "New Person" and preview["email"] == "new.person@example.com"

    client = APIClient()
    resp = _register(client, token)
    assert resp.status_code == 201, resp.content

    user = User.objects.get(email="new.person@example.com")
    assert user.check_password(NEW_PASSWORD)
    assert user.first_name == "Ada" and user.last_name == "Lovelace"
    assert EmailAddress.objects.get(user=user).verified is True
    session = client.get("/api/v1/session/").json()
    assert session["active"]["organization"]["id"] == str(org_a.org.pk)
    assert session["active"]["role"]["key"] == "sales_rep"
    # no personal workspace was created for the invitee: they belong to exactly one organization
    assert len(session["memberships"]) == 1
    with tenant_context(org_a.org.pk):
        membership = Membership.objects.get(user=user)
        assert TeamMembership.objects.filter(membership=membership, team=team).exists()
        assert Invitation.objects.get(email=user.email).accepted_by_id == membership.pk
    assert _audit("members.joined", actor_user=user)
    assert _audit("auth.login", actor_user=user)


def test_register_ignores_forged_organization_role_and_email(org_a, org_b, owner_client):
    _, token = _invite(owner_client, "victim@example.com", role="viewer")
    resp = _register(
        APIClient(),
        token,
        organization_id=str(org_b.org.pk),
        organization=str(org_b.org.pk),
        role="owner",
        email="attacker@example.com",
        team_id="00000000-0000-0000-0000-000000000000",
    )
    assert resp.status_code == 201
    user = User.objects.get(email="victim@example.com")
    assert not User.objects.filter(email="attacker@example.com").exists()
    with system_context("test"):
        memberships = list(Membership.all_objects.filter(user=user).select_related("role"))
    assert [(m.organization_id, m.role.key) for m in memberships] == [(org_a.org.pk, "viewer")]


def test_invitation_token_is_single_use(org_a, owner_client):
    _, token = _invite(owner_client, "once@example.com")
    assert _register(APIClient(), token).status_code == 201
    second = _register(APIClient(), token, password="Another-Str0ng-Pass-9!")
    assert second.status_code == 404
    assert second.json()["type"] == "invitation_invalid"
    assert User.objects.get(email="once@example.com").check_password(NEW_PASSWORD)


def test_expired_invitation_is_rejected(org_a, owner_client, make_user, client_for):
    data, token = _invite(owner_client, "late@example.com")
    with tenant_context(org_a.org.pk):
        Invitation.objects.filter(pk=data["id"]).update(expires_at=timezone.now() - timedelta(minutes=1))
    assert APIClient().get(f"/api/v1/invitations/preview/?token={token}").status_code == 404
    assert _register(APIClient(), token).status_code == 404
    user = make_user("late@example.com")
    assert client_for(user).post("/api/v1/invitations/accept/", {"token": token}, format="json").status_code == 404
    assert not Membership.identity.for_user(user).exists()


def test_register_refuses_existing_account_without_touching_it(org_a, owner_client, make_user):
    existing = make_user("taken@example.com")
    _, token = _invite(owner_client, "taken@example.com")
    resp = _register(APIClient(), token, password="Hijack-Str0ng-Pass-1!")
    assert resp.status_code == 409
    assert resp.json()["type"] == "account_exists"
    existing.refresh_from_db()
    assert existing.check_password(DEFAULT_PASSWORD)
    # the invitation is still usable by the real owner of the account after signing in
    assert APIClient().get(f"/api/v1/invitations/preview/?token={token}").status_code == 200


def test_register_validates_password_and_rolls_back(org_a, owner_client):
    _, token = _invite(owner_client, "weak@example.com")
    for bad in ("short", "weak@example.com", "password1234"):
        resp = _register(APIClient(), token, password=bad)
        assert resp.status_code == 400, bad
        assert any(e["field"] == "password" for e in resp.json()["errors"])
    assert not User.objects.filter(email="weak@example.com").exists()
    assert APIClient().get(f"/api/v1/invitations/preview/?token={token}").status_code == 200


def test_register_requires_csrf_token(org_a, owner_client):
    _, token = _invite(owner_client, "csrf@example.com")
    client = APIClient(enforce_csrf_checks=True)
    assert _register(client, token).status_code == 403
    assert not User.objects.filter(email="csrf@example.com").exists()


def test_register_refused_for_signed_in_browser(org_a, owner_client):
    _, token = _invite(owner_client, "someone-else@example.com")
    assert _register(owner_client, token).status_code == 409
    assert not User.objects.filter(email="someone-else@example.com").exists()


def test_org_mfa_policy_applies_to_new_invitee(org_a, owner_client, reauthenticate):
    Authenticator.objects.create(user=org_a.owner, type=Authenticator.Type.TOTP, data={})
    reauthenticate(owner_client)
    assert owner_client.patch("/api/v1/organizations/current/", {"require_mfa": True}, format="json").status_code == 200
    _, token = _invite(owner_client, "mfa@example.com")
    client = APIClient()
    assert _register(client, token).status_code == 201
    assert client.get("/api/v1/session/").json()["active"]["mfa_required"] is True
    resp = client.get("/api/v1/contacts/")
    assert resp.status_code == 403 and resp.json()["type"] == "mfa_required"


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_concurrent_registration_with_one_token_creates_one_account(org_a, owner_client):
    _, token = _invite(owner_client, "race@example.com")
    results: list[int] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def worker(password):
        try:
            barrier.wait(timeout=5)
            results.append(_register(APIClient(), token, password=password).status_code)
        except BaseException as exc:  # collected and asserted below
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=worker, args=(p,)) for p in (NEW_PASSWORD, "Other-Str0ng-Passw0rd!")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not errors, errors
    assert sorted(results) == [201, 404]
    assert User.objects.filter(email="race@example.com").count() == 1
    with system_context("test"):
        assert Membership.all_objects.filter(user__email="race@example.com").count() == 1


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_concurrent_acceptance_by_existing_user_joins_once(org_a, owner_client, make_user):
    user = make_user("both-tabs@example.com")
    _, token = _invite(owner_client, user.email)
    outcomes: list[str] = []
    barrier = threading.Barrier(2)

    def worker():
        try:
            barrier.wait(timeout=5)
            services.accept_invitation(user, token)
            outcomes.append("joined")
        except DomainError as exc:
            outcomes.append(exc.code)
        finally:
            connection.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert sorted(outcomes) == ["invitation_invalid", "joined"]
    with system_context("test"):
        assert Membership.all_objects.filter(user=user).count() == 1


# ----------------------------------------------------------------------------- inviting


@pytest.mark.parametrize("role", ["sales_manager", "sales_rep", "viewer"])
def test_non_admins_cannot_invite(org_a, make_member, client_for, role):
    member = make_member(org_a, role)
    resp = client_for(member.user, member).post(
        "/api/v1/invitations/", {"email": "x@example.com", "role": "viewer"}, format="json"
    )
    assert resp.status_code == 403
    assert not mail.outbox


def test_sales_rep_cannot_invite_admin(org_a, make_member, client_for, reauthenticate):
    rep = make_member(org_a, "sales_rep")
    client = client_for(rep.user, rep)
    reauthenticate(client)
    assert (
        client.post("/api/v1/invitations/", {"email": "boss@example.com", "role": "admin"}, format="json").status_code
        == 403
    )


def test_inviting_an_admin_requires_recent_authentication(org_a, owner_client, reauthenticate):
    resp = owner_client.post("/api/v1/invitations/", {"email": "adm@example.com", "role": "admin"}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "reauth_required"
    reauthenticate(owner_client)
    assert _invite(owner_client, "adm@example.com", role="admin")[0]["role"]["key"] == "admin"


def test_invitation_ignores_forged_organization_id(org_a, org_b, owner_client):
    data, _ = _invite(owner_client, "forged@example.com", organization_id=str(org_b.org.pk))
    with system_context("test"):
        assert Invitation.all_objects.get(pk=data["id"]).organization_id == org_a.org.pk


def test_invitation_team_must_belong_to_the_organization(org_a, org_b, owner_client):
    foreign = _team(org_b, "Their team")
    resp = owner_client.post(
        "/api/v1/invitations/", {"email": "t@example.com", "role": "viewer", "team_id": str(foreign.pk)}, format="json"
    )
    assert resp.status_code == 404
    assert resp.json()["type"] == "team_not_found"


def test_resend_rotates_token_and_is_rate_limited(org_a, owner_client):
    data, old_token = _invite(owner_client, "resend@example.com")
    with tenant_context(org_a.org.pk):
        Invitation.objects.filter(pk=data["id"]).update(last_sent_at=timezone.now() - timedelta(minutes=5))
    resp = owner_client.post(f"/api/v1/invitations/{data['id']}/resend/", {}, format="json")
    assert resp.status_code == 200 and resp.json()["send_count"] == 2
    new_token = extract_link_key(mail.outbox[-1].body, "token=")
    assert new_token != old_token
    assert APIClient().get(f"/api/v1/invitations/preview/?token={old_token}").status_code == 404
    assert APIClient().get(f"/api/v1/invitations/preview/?token={new_token}").status_code == 200
    # immediately again: cooldown
    again = owner_client.post(f"/api/v1/invitations/{data['id']}/resend/", {}, format="json")
    assert again.status_code == 429
    assert _audit("members.invitation_resent", organization_id=org_a.org.pk)


def test_seat_limit_blocks_invitations_and_acceptance(org_a, owner_client, make_user, client_for):
    with system_context("test"):
        Organization.objects.filter(pk=org_a.org.pk).update(settings={"max_users": 2})
    _invite(owner_client, "second@example.com")  # owner + this pending invitation = 2 seats
    resp = owner_client.post("/api/v1/invitations/", {"email": "third@example.com", "role": "viewer"}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "user_limit_reached"
    # re-inviting the same address replaces its invitation instead of taking a new seat
    _invite(owner_client, "second@example.com")
    assert _register(APIClient(), extract_link_key(mail.outbox[-1].body, "token=")).status_code == 201


# ----------------------------------------------------------------------------- member lifecycle


def test_member_list_shows_team_mfa_and_last_login(org_a, owner_client, make_member):
    member = make_member(org_a, "viewer")
    team = _team(org_a, "Inside Sales")
    with tenant_context(org_a.org.pk):
        TeamMembership.objects.create(team=team, membership=member)
    Authenticator.objects.create(user=member.user, type=Authenticator.Type.TOTP, data={})
    rows = {r["id"]: r for r in owner_client.get("/api/v1/members/").json()["results"]}
    row = rows[str(member.pk)]
    assert row["teams"] == [{"id": str(team.pk), "name": "Inside Sales"}]
    assert row["mfa_enabled"] is True and row["display_status"] == "active"
    assert "last_login" in row
    assert rows[str(org_a.owner_membership.pk)]["mfa_enabled"] is False


def test_remove_member_revokes_access_and_reinvite_restores(
    org_a, owner_client, make_member, client_for, reauthenticate
):
    member = make_member(org_a, "sales_manager")
    team = _team(org_a)
    with tenant_context(org_a.org.pk):
        TeamMembership.objects.create(team=team, membership=member)
    target = client_for(member.user, member)
    assert target.get("/api/v1/contacts/").status_code == 200

    assert owner_client.post(f"/api/v1/members/{member.pk}/remove/", {}, format="json").status_code == 403
    reauthenticate(owner_client)
    resp = owner_client.post(f"/api/v1/members/{member.pk}/remove/", {}, format="json")
    assert resp.status_code == 200 and resp.json()["status"] == "disabled"
    assert resp.json()["teams"] == []
    assert target.get("/api/v1/contacts/").status_code in (401, 403)
    assert client_for(member.user, member).get("/api/v1/session/").json()["active"] is None
    # removed users are not reactivated directly...
    assert owner_client.post(f"/api/v1/members/{member.pk}/reactivate/", {}, format="json").status_code == 409
    assert _audit("members.removed", organization_id=org_a.org.pk)

    # ...but a new invitation brings them back with the newly invited role
    _, token = _invite(owner_client, member.user.email, role="viewer")
    fresh = client_for(member.user)
    assert fresh.post("/api/v1/invitations/accept/", {"token": token}, format="json").status_code == 200
    with tenant_context(org_a.org.pk):
        restored = Membership.objects.select_related("role").get(pk=member.pk)
    assert restored.status == "active" and restored.role.key == "viewer"


def test_admin_cannot_remove_or_suspend_owner_and_nobody_removes_self(
    org_a, make_member, client_for, reauthenticate, owner_client
):
    admin = make_member(org_a, "admin")
    client = client_for(admin.user, admin)
    reauthenticate(client)
    owner_id = org_a.owner_membership.pk
    assert client.post(f"/api/v1/members/{owner_id}/remove/", {}, format="json").status_code == 403
    assert client.post(f"/api/v1/members/{owner_id}/suspend/", {}, format="json").status_code == 403
    assert client.post(f"/api/v1/members/{owner_id}/revoke-sessions/", {}, format="json").status_code == 403
    assert client.post(f"/api/v1/members/{admin.pk}/remove/", {}, format="json").status_code == 403
    reauthenticate(owner_client)
    resp = owner_client.post(f"/api/v1/members/{owner_id}/remove/", {}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "self_remove"


@pytest.mark.parametrize("role", ["sales_manager", "sales_rep", "viewer"])
def test_non_admins_cannot_manage_members(org_a, make_member, client_for, reauthenticate, role):
    actor = make_member(org_a, role)
    target = make_member(org_a, "viewer")
    client = client_for(actor.user, actor)
    reauthenticate(client)
    for path in ("suspend", "reactivate", "remove", "revoke-sessions"):
        assert client.post(f"/api/v1/members/{target.pk}/{path}/", {}, format="json").status_code == 403, path
    assert client.put(f"/api/v1/members/{target.pk}/teams/", {"team_ids": []}, format="json").status_code == 403


def test_revoke_sessions_signs_member_out_everywhere(org_a, owner_client, make_member, client_for):
    member = make_member(org_a, "viewer")
    a, b = client_for(member.user, member), client_for(member.user, member)
    assert a.get("/api/v1/session/").status_code == 200
    resp = owner_client.post(f"/api/v1/members/{member.pk}/revoke-sessions/", {}, format="json")
    assert resp.status_code == 200
    assert a.get("/api/v1/session/").status_code in (401, 403)
    assert b.get("/api/v1/session/").status_code in (401, 403)
    # access itself is unchanged
    with tenant_context(org_a.org.pk):
        assert Membership.objects.get(pk=member.pk).status == "active"
    assert _audit("auth.sessions_revoked", organization_id=org_a.org.pk)


def test_set_member_teams_rejects_foreign_teams(org_a, org_b, owner_client, make_member):
    member = make_member(org_a, "viewer")
    mine, foreign = _team(org_a, "Mine"), _team(org_b, "Foreign")
    resp = owner_client.put(
        f"/api/v1/members/{member.pk}/teams/", {"team_ids": [str(mine.pk), str(foreign.pk)]}, format="json"
    )
    assert resp.status_code == 404
    resp = owner_client.put(f"/api/v1/members/{member.pk}/teams/", {"team_ids": [str(mine.pk)]}, format="json")
    assert resp.status_code == 200 and [t["name"] for t in resp.json()["teams"]] == ["Mine"]
    resp = owner_client.put(f"/api/v1/members/{member.pk}/teams/", {"team_ids": []}, format="json")
    assert resp.json()["teams"] == []
    assert _audit("members.teams_changed", organization_id=org_a.org.pk)


def test_member_of_other_org_is_not_addressable(org_a, org_b, owner_client, make_member, reauthenticate):
    foreign = make_member(org_b, "viewer")
    reauthenticate(owner_client)
    for path in ("suspend", "remove", "revoke-sessions"):
        assert owner_client.post(f"/api/v1/members/{foreign.pk}/{path}/", {}, format="json").status_code == 404
    with tenant_context(org_b.org.pk):
        assert Membership.objects.get(pk=foreign.pk).status == "active"


def test_disabled_account_shows_as_disabled(org_a, owner_client, make_member):
    member = make_member(org_a, "viewer")
    User.objects.filter(pk=member.user_id).update(is_active=False)
    rows = {r["id"]: r for r in owner_client.get("/api/v1/members/").json()["results"]}
    assert rows[str(member.pk)]["display_status"] == "disabled"
