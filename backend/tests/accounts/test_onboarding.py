"""Automatic onboarding: sign up → verify → the workspace exists → login opens a working CRM.

Covers idempotency (double callbacks, refreshes, concurrent requests), rollback, the bootstrap
endpoint ignoring client input, and isolation between automatically created workspaces.
"""

from __future__ import annotations

import threading

import pytest
from django.conf import settings
from django.core import mail
from django.db import connection
from rest_framework.test import APIClient

from apps.accounts import services
from apps.accounts.models import Membership, Organization, User
from apps.audit.models import AuditEvent
from apps.core.tenancy.context import system_context, tenant_context
from apps.pipelines.models import Pipeline, PipelineStage
from tests.accounts.conftest import AUTH
from tests.conftest import extract_link_key
from tests.factories import DEFAULT_PASSWORD

pytestmark = pytest.mark.django_db

EXPECTED_STAGES = ["Qualification", "Needs analysis", "Proposal", "Negotiation", "Closed won", "Closed lost"]


def _memberships(user) -> list[Membership]:
    with system_context("test.onboarding"):
        return list(Membership.identity.for_user(user).select_related("organization", "role"))


def _organizations_owned_by(user) -> int:
    with system_context("test.onboarding"):
        return Organization.identity.for_user(user).count()


def _signup_and_verify(email: str, name: str = "Ada Lovelace") -> APIClient:
    client = APIClient()
    resp = client.post(AUTH + "signup", {"email": email, "password": DEFAULT_PASSWORD, "name": name}, format="json")
    assert resp.status_code == 401, resp.content  # verify_email flow pending
    key = extract_link_key(str(mail.outbox[-1].body), "/verify-email/")
    resp = client.post(AUTH + "email/verify", {"key": key}, format="json")
    assert resp.status_code in (200, 401), resp.content
    return client


def test_signup_verify_creates_workspace_and_login_opens_crm():
    email = "ada@example.com"
    client = _signup_and_verify(email)
    user = User.objects.get(email=email)
    assert (user.first_name, user.last_name) == ("Ada", "Lovelace")

    # The workspace exists before the first login, entirely server-side.
    memberships = _memberships(user)
    assert len(memberships) == 1
    membership = memberships[0]
    assert membership.role.key == "owner"
    assert membership.status == "active"
    org = membership.organization
    assert org.name == "Ada's workspace"
    assert org.base_currency == settings.DEFAULT_ORGANIZATION_CURRENCY
    assert org.timezone == settings.DEFAULT_ORGANIZATION_TIMEZONE
    with tenant_context(org.pk, reason="test.onboarding"):
        pipelines = list(Pipeline.objects.all())
        assert len(pipelines) == 1 and pipelines[0].is_default and pipelines[0].name == "Sales pipeline"
        stages = list(PipelineStage.objects.filter(pipeline=pipelines[0]).order_by("position"))
        assert [s.name for s in stages] == EXPECTED_STAGES
        assert [s.kind for s in stages] == ["open", "open", "open", "open", "won", "lost"]
    with system_context("test.onboarding"):
        created = AuditEvent.objects.filter(action="org.created", organization_id=org.pk).get()
    assert created.metadata["source"] == "auto"
    assert created.actor_user_id == user.pk

    # Login lands straight in that workspace: no organization step, pipeline ready.
    resp = client.post(AUTH + "login", {"email": email, "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 200
    session = client.get("/api/v1/session/").json()
    assert session["active"]["organization"]["id"] == str(org.pk)
    assert session["active"]["role"]["key"] == "owner"
    assert len(session["memberships"]) == 1
    board = client.get("/api/v1/deals/board/")
    assert board.status_code == 200
    assert [s["name"] for s in board.json()["stages"]] == EXPECTED_STAGES
    assert (
        client.post("/api/v1/contacts/", {"first_name": "First", "last_name": "Lead"}, format="json").status_code == 201
    )


def test_repeated_verification_login_and_bootstrap_never_duplicate_the_workspace():
    email = "twice@example.com"
    client = _signup_and_verify(email)
    user = User.objects.get(email=email)
    assert _organizations_owned_by(user) == 1

    # Direct re-entry (a retried callback) is a no-op.
    assert services.ensure_personal_organization(user) is None
    # Logins from two browsers and repeated bootstrap calls change nothing.
    for browser in (client, APIClient()):
        assert (
            browser.post(AUTH + "login", {"email": email, "password": DEFAULT_PASSWORD}, format="json").status_code
            == 200
        )
    first = client.post("/api/v1/session/bootstrap/", {}, format="json")
    second = client.post("/api/v1/session/bootstrap/", {}, format="json")
    assert first.status_code == second.status_code == 200
    assert first.json()["active"]["membership_id"] == second.json()["active"]["membership_id"]
    assert _organizations_owned_by(user) == 1
    with system_context("test.onboarding"):
        assert AuditEvent.objects.filter(action="org.created", actor_user=user).count() == 1


def test_login_fallback_creates_workspace_for_account_verified_before_auto_onboarding(make_user):
    """Existing verified accounts without any organization get their workspace on next login."""
    user = make_user("legacy@example.com")  # factory: verified, no organization
    assert _memberships(user) == []
    client = APIClient()
    assert (
        client.post(AUTH + "login", {"email": user.email, "password": DEFAULT_PASSWORD}, format="json").status_code
        == 200
    )
    session = client.get("/api/v1/session/").json()
    assert session["active"] is not None
    assert session["active"]["role"]["key"] == "owner"
    assert _organizations_owned_by(user) == 1
    # a login from another browser does not create another
    other = APIClient()
    assert (
        other.post(AUTH + "login", {"email": user.email, "password": DEFAULT_PASSWORD}, format="json").status_code
        == 200
    )
    assert _organizations_owned_by(user) == 1


def test_bootstrap_endpoint_creates_and_activates_without_client_input(make_user, org_b, client_for):
    user = make_user("fresh@example.com")
    client = client_for(user)  # signed in (force_login: no allauth login signal), no organization
    assert client.get("/api/v1/session/").json()["active"] is None
    assert client.get("/api/v1/contacts/").status_code == 403

    # A forged payload naming another tenant, membership and role is ignored entirely.
    forged = {
        "organization_id": str(org_b.org.pk),
        "membership_id": str(org_b.owner_membership.pk),
        "role": "owner",
        "name": "Hijacked",
        "base_currency": "USD",
    }
    resp = client.post("/api/v1/session/bootstrap/", forged, format="json")
    assert resp.status_code == 200, resp.content
    active = resp.json()["active"]
    assert active is not None
    assert active["organization"]["id"] != str(org_b.org.pk)
    assert active["organization"]["name"] == "Test's workspace"
    assert active["organization"]["base_currency"] == settings.DEFAULT_ORGANIZATION_CURRENCY
    assert active["role"]["key"] == "owner"
    assert active["membership_id"] != str(org_b.owner_membership.pk)
    # the session now works and Org B is untouched
    assert client.get("/api/v1/contacts/").status_code == 200
    with tenant_context(org_b.org.pk, reason="test.onboarding"):
        assert Membership.objects.filter(user=user).count() == 0
    assert _organizations_owned_by(user) == 1


def test_bootstrap_endpoint_activates_existing_membership_and_rotates_session(org_a, client_for):
    client = client_for(org_a.owner)  # session without an active membership
    before = client.session.session_key
    resp = client.post("/api/v1/session/bootstrap/", {}, format="json")
    assert resp.status_code == 200
    assert resp.json()["active"]["organization"]["id"] == str(org_a.org.pk)
    assert client.session.session_key != before
    assert _organizations_owned_by(org_a.owner) == 1  # nothing created for a member of an organization


def test_bootstrap_requires_authentication(anon_client):
    assert anon_client.post("/api/v1/session/bootstrap/", {}, format="json").status_code in (401, 403)


def test_workspace_creation_rolls_back_completely_on_failure(make_user, monkeypatch):
    user = make_user("rollback@example.com")

    def boom():
        raise RuntimeError("pipeline seeding failed")

    monkeypatch.setattr("apps.pipelines.services.ensure_default_pipeline", boom)
    with pytest.raises(RuntimeError):
        services.ensure_personal_organization(user)
    assert _memberships(user) == []
    with system_context("test.onboarding"):
        assert not Organization.identity.for_user(user).exists()
        assert not AuditEvent.objects.filter(action="org.created", actor_user=user).exists()

    # Once the dependency works again the same call succeeds: nothing half-created blocks it.
    monkeypatch.undo()
    membership = services.ensure_personal_organization(user)
    assert membership is not None and membership.role.key == "owner"
    assert _organizations_owned_by(user) == 1


def test_disabled_account_gets_no_workspace(make_user):
    user = make_user("disabled@example.com")
    User.objects.filter(pk=user.pk).update(is_active=False)
    user.refresh_from_db()
    assert services.ensure_personal_organization(user) is None
    assert _memberships(user) == []


def test_invited_user_lands_in_the_inviting_organization(org_a, make_user, crm):
    """An invitee still gets a personal workspace, but accepting the invitation activates the team's."""
    invitee = make_user("invitee@example.com")
    invitation = crm.make_invitation(org_a, email=invitee.email)
    token = extract_link_key(mail.outbox[-1].body, "token=")
    assert invitation.is_pending
    client = APIClient()
    assert (
        client.post(AUTH + "login", {"email": invitee.email, "password": DEFAULT_PASSWORD}, format="json").status_code
        == 200
    )
    assert client.post("/api/v1/invitations/accept/", {"token": token}, format="json").status_code == 200
    session = client.get("/api/v1/session/").json()
    assert session["active"]["organization"]["name"] == "Org A"
    assert {m["role"]["key"] for m in session["memberships"]} == {"owner", "sales_rep"}


def test_auto_created_workspaces_are_isolated_from_each_other():
    a = _signup_and_verify("owner-a@example.com", name="Alice")
    b = _signup_and_verify("owner-b@example.com", name="Bob")
    for client, email in ((a, "owner-a@example.com"), (b, "owner-b@example.com")):
        assert (
            client.post(AUTH + "login", {"email": email, "password": DEFAULT_PASSWORD}, format="json").status_code
            == 200
        )
    contact = a.post("/api/v1/contacts/", {"first_name": "Private", "last_name": "Lead"}, format="json").json()
    assert b.get("/api/v1/contacts/").json()["results"] == []
    assert b.get(f"/api/v1/contacts/{contact['id']}/").status_code == 404
    assert b.patch(f"/api/v1/contacts/{contact['id']}/", {"first_name": "X"}, format="json").status_code == 404
    # Bob cannot switch into Alice's membership either.
    alice_membership = _memberships(User.objects.get(email="owner-a@example.com"))[0]
    resp = b.post("/api/v1/session/switch-organization/", {"membership_id": str(alice_membership.pk)}, format="json")
    assert resp.status_code == 404


def test_signup_name_is_optional_and_sanitized():
    client = APIClient()
    resp = client.post(
        AUTH + "signup",
        {"email": "messy@example.com", "password": DEFAULT_PASSWORD, "name": "  Grace\x07   Brewster  Hopper\t "},
        format="json",
    )
    assert resp.status_code == 401
    user = User.objects.get(email="messy@example.com")
    assert (user.first_name, user.last_name) == ("Grace", "Brewster Hopper")

    # NUL bytes are refused outright (Django's null-character validator), not silently stored.
    resp = client.post(
        AUTH + "signup",
        {"email": "nul@example.com", "password": DEFAULT_PASSWORD, "name": "Eve\x00Adams"},
        format="json",
    )
    assert resp.status_code == 400
    assert not User.objects.filter(email="nul@example.com").exists()

    resp = client.post(AUTH + "signup", {"email": "noname@example.com", "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 401
    user = User.objects.get(email="noname@example.com")
    assert (user.first_name, user.last_name) == ("", "")
    assert services.personal_organization_name(user) == "noname's workspace"

    resp = client.post(
        AUTH + "signup", {"email": "long@example.com", "password": DEFAULT_PASSWORD, "name": "x" * 121}, format="json"
    )
    assert resp.status_code == 400
    assert not User.objects.filter(email="long@example.com").exists()


@pytest.mark.django_db(transaction=True, serialized_rollback=True)
def test_concurrent_workspace_creation_yields_exactly_one(make_user):
    """Two overlapping requests (double verification callback, two tabs) serialize on the user row."""
    user = make_user("race@example.com")
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def worker():
        try:
            barrier.wait(timeout=5)
            services.ensure_personal_organization(user)
        except BaseException as exc:  # collected and asserted below
            errors.append(exc)
        finally:
            connection.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not errors, errors
    assert _organizations_owned_by(user) == 1
    assert len(_memberships(user)) == 1
