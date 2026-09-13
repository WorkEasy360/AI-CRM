"""Sign-up, verification, login, logout, password reset/change, session rotation and revocation."""

from __future__ import annotations

import pytest
from django.core import mail
from django.test import override_settings
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.audit.models import AuditEvent
from apps.core.tenancy.context import system_context
from tests.accounts.conftest import ACCOUNT, AUTH
from tests.conftest import extract_link_key
from tests.factories import DEFAULT_PASSWORD

pytestmark = pytest.mark.django_db


def _audit_actions(**filters) -> list[str]:
    with system_context("test.audit"):
        return list(AuditEvent.objects.filter(**filters).order_by("created_at").values_list("action", flat=True))


def test_signup_requires_verification_then_login_and_org_creation():
    client = APIClient()
    email = "newuser@example.com"
    resp = client.post(AUTH + "signup", {"email": email, "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 401  # pending email verification flow
    assert any(f["id"] == "verify_email" for f in resp.json()["data"]["flows"])
    assert len(mail.outbox) == 1
    key = extract_link_key(mail.outbox[0].body, "/verify-email/")

    # login before verification is refused
    resp = client.post(AUTH + "login", {"email": email, "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 401

    resp = client.post(AUTH + "email/verify", {"key": key}, format="json")
    assert resp.status_code in (200, 401)  # verified; not logged in (LOGIN_ON_EMAIL_CONFIRMATION=False)

    resp = client.post(AUTH + "login", {"email": email, "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 200
    session_key_after_login = client.session.session_key

    # Verification created the personal workspace, so login lands in it (see test_onboarding.py).
    resp = client.get("/api/v1/session/")
    assert resp.status_code == 200
    assert resp.json()["active"]["role"]["key"] == "owner"
    assert len(resp.json()["memberships"]) == 1

    # Creating a further organization explicitly still works for enterprise setups.
    resp = client.post("/api/v1/organizations/", {"name": "Acme"}, format="json")
    assert resp.status_code == 201
    assert client.session.session_key != session_key_after_login  # rotated on privilege change

    resp = client.get("/api/v1/session/")
    body = resp.json()
    assert body["active"]["organization"]["name"] == "Acme"
    assert body["active"]["role"]["key"] == "owner"
    assert body["active"]["permissions"]["org.delete"] == "all"

    resp = client.delete(AUTH + "session")
    assert resp.status_code == 401
    assert client.get("/api/v1/session/").status_code in (401, 403)

    user = User.objects.get(email=email)
    actions = _audit_actions(actor_user=user)
    assert "auth.email_verified" in actions
    assert "auth.login" in actions
    assert "org.created" in actions
    assert "auth.logout" in actions


def test_signup_with_existing_email_does_not_enumerate(make_user):
    existing = make_user("taken@example.com")
    client = APIClient()
    resp = client.post(AUTH + "signup", {"email": existing.email, "password": DEFAULT_PASSWORD}, format="json")
    # allauth strict enumeration prevention: same shape as a fresh signup
    assert resp.status_code == 401
    assert User.objects.filter(email=existing.email).count() == 1


def test_weak_password_rejected():
    client = APIClient()
    resp = client.post(AUTH + "signup", {"email": "weak@example.com", "password": "password"}, format="json")
    assert resp.status_code == 400
    assert not User.objects.filter(email="weak@example.com").exists()


def test_failed_login_is_audited_without_password(make_user):
    user = make_user()
    client = APIClient()
    resp = client.post(AUTH + "login", {"email": user.email, "password": "wrong-password-xx"}, format="json")
    assert resp.status_code == 400
    with system_context("test.audit"):
        event = AuditEvent.objects.filter(action="auth.login_failed").latest("created_at")
    assert event.metadata["email"] == user.email
    assert "wrong-password" not in str(event.metadata)


@override_settings(ACCOUNT_RATE_LIMITS={"login_failed": "10/m/ip,3/900s/key"})
def test_login_lockout_after_repeated_failures(make_user):
    user = make_user()
    client = APIClient()
    for _ in range(3):
        client.post(AUTH + "login", {"email": user.email, "password": "wrong-password-xx"}, format="json")
    resp = client.post(AUTH + "login", {"email": user.email, "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code in (400, 429)


def test_login_rotates_session_key(make_user):
    user = make_user()
    client = APIClient()
    client.get("/api/v1/invitations/preview/?token=x")  # establishes an anonymous session cookie
    before = client.session.session_key
    resp = client.post(AUTH + "login", {"email": user.email, "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 200
    assert client.session.session_key != before


def test_password_change_revokes_other_sessions(make_user):
    user = make_user()
    client_a, client_b = APIClient(), APIClient()
    for c in (client_a, client_b):
        assert (
            c.post(AUTH + "login", {"email": user.email, "password": DEFAULT_PASSWORD}, format="json").status_code
            == 200
        )
        assert c.get("/api/v1/session/").status_code == 200
    resp = client_a.post(
        ACCOUNT + "password/change",
        {"current_password": DEFAULT_PASSWORD, "new_password": "An0ther-Str0ng-Pass!"},
        format="json",
    )
    assert resp.status_code in (200, 401)
    assert client_b.get("/api/v1/session/").status_code in (401, 403)
    assert "auth.password_changed" in _audit_actions(actor_user=user)


def test_password_reset_flow_is_single_use(make_user):
    user = make_user()
    client = APIClient()
    resp = client.post(AUTH + "password/request", {"email": user.email}, format="json")
    assert resp.status_code == 200
    key = extract_link_key(mail.outbox[-1].body, "/reset-password/")
    resp = client.post(AUTH + "password/reset", {"key": key, "password": "Fresh-Str0ng-Pass-42!"}, format="json")
    assert resp.status_code in (200, 401)
    resp = client.post(AUTH + "password/reset", {"key": key, "password": "Fresh-Str0ng-Pass-43!"}, format="json")
    assert resp.status_code == 400
    assert (
        client.post(
            AUTH + "login", {"email": user.email, "password": "Fresh-Str0ng-Pass-42!"}, format="json"
        ).status_code
        == 200
    )


def test_password_reset_for_unknown_email_is_generic():
    client = APIClient()
    resp = client.post(AUTH + "password/request", {"email": "nobody@example.com"}, format="json")
    assert resp.status_code == 200


def test_switch_organization_rotates_session_and_requires_membership(make_org, make_member, client_for):
    a = make_org("A")
    b = make_org("B")
    b_membership = make_member(b, "viewer", user=a.owner)
    client = client_for(a.owner, a.owner_membership)
    before = client.session.session_key
    resp = client.post("/api/v1/session/switch-organization/", {"membership_id": str(b_membership.pk)}, format="json")
    assert resp.status_code == 200
    assert client.session.session_key != before
    assert client.get("/api/v1/session/").json()["active"]["organization"]["name"] == "B"
    # a membership that is not the user's own
    resp = client.post(
        "/api/v1/session/switch-organization/", {"membership_id": str(b.owner_membership.pk)}, format="json"
    )
    assert resp.status_code == 404


def test_disabled_user_cannot_use_session(make_org, client_for):
    a = make_org()
    client = client_for(a.owner, a.owner_membership)
    assert client.get("/api/v1/session/").status_code == 200
    User.objects.filter(pk=a.owner.pk).update(is_active=False)
    assert client.get("/api/v1/session/").status_code in (401, 403)


def test_idle_session_timeout(make_org, client_for, settings):
    from datetime import timedelta

    from django.utils import timezone

    from apps.core.tenancy.middleware import LAST_SEEN_KEY

    a = make_org()
    client = client_for(a.owner, a.owner_membership)
    assert client.get("/api/v1/session/").status_code == 200
    session = client.session
    session[LAST_SEEN_KEY] = (
        timezone.now() - timedelta(seconds=settings.SESSION_IDLE_TIMEOUT_SECONDS + 60)
    ).isoformat()
    session.save()
    resp = client.get("/api/v1/session/")
    assert resp.status_code == 401
    assert resp.json()["type"] == "session_expired"
