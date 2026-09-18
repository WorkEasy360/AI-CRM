"""Forgot / reset password on top of allauth: enumeration safety, token lifetime, sessions and MFA."""

from __future__ import annotations

from unittest import mock

import pytest
from allauth.mfa.models import Authenticator
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core import mail
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.core.tenancy.context import system_context
from tests.accounts.conftest import AUTH
from tests.conftest import extract_link_key
from tests.factories import DEFAULT_PASSWORD

pytestmark = pytest.mark.django_db

NEW_PASSWORD = "Brand-New-Str0ng-Pass!"


def _request_reset(client: APIClient, email: str):
    return client.post(AUTH + "password/request", {"email": email}, format="json")


def _reset_key() -> str:
    return extract_link_key(str(mail.outbox[-1].body), "/reset-password/")


def test_unknown_and_registered_emails_get_identical_responses(make_user):
    user = make_user("known@example.com")
    known = _request_reset(APIClient(), user.email)
    unknown = _request_reset(APIClient(), "nobody-here@example.com")
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()
    # Both paths send one email (the unknown address gets an "no account" notice, not a reset link),
    # so the work done - and so the response time - does not depend on whether the account exists.
    assert len(mail.outbox) == 2
    assert "/reset-password/" in mail.outbox[0].body
    assert "/reset-password/" not in mail.outbox[1].body


def test_reset_changes_password_revokes_sessions_and_notifies(make_user):
    user = make_user()
    signed_in = APIClient()
    assert (
        signed_in.post(AUTH + "login", {"email": user.email, "password": DEFAULT_PASSWORD}, format="json").status_code
        == 200
    )
    assert signed_in.get("/api/v1/session/").status_code == 200

    client = APIClient()
    assert _request_reset(client, user.email).status_code == 200
    key = _reset_key()
    sent_before = len(mail.outbox)
    resp = client.post(AUTH + "password/reset", {"key": key, "password": NEW_PASSWORD}, format="json")
    assert resp.status_code in (200, 401)
    # not signed in by the reset itself
    assert client.get("/api/v1/session/").status_code in (401, 403)
    # every existing session is gone
    assert signed_in.get("/api/v1/session/").status_code in (401, 403)
    # the account owner is told
    assert len(mail.outbox) > sent_before
    user.refresh_from_db()
    assert user.check_password(NEW_PASSWORD) and not user.check_password(DEFAULT_PASSWORD)
    assert user.password_changed_at is not None
    with system_context("test"):
        assert AuditEvent.objects.filter(action="auth.password_reset", actor_user=user).exists()


def test_reset_token_cannot_be_reused(make_user):
    user = make_user()
    _request_reset(APIClient(), user.email)
    key = _reset_key()
    client = APIClient()
    assert client.post(AUTH + "password/reset", {"key": key, "password": NEW_PASSWORD}, format="json").status_code in (
        200,
        401,
    )
    again = client.post(AUTH + "password/reset", {"key": key, "password": "Yet-Another-Str0ng-1!"}, format="json")
    assert again.status_code == 400
    user.refresh_from_db()
    assert user.check_password(NEW_PASSWORD)


def test_expired_reset_token_is_rejected(make_user, settings):
    user = make_user()
    _request_reset(APIClient(), user.email)
    key = _reset_key()
    real_now = PasswordResetTokenGenerator._now
    with mock.patch.object(
        PasswordResetTokenGenerator,
        "_now",
        lambda self: real_now(self).replace(year=real_now(self).year + 1),
    ):
        resp = APIClient().post(AUTH + "password/reset", {"key": key, "password": NEW_PASSWORD}, format="json")
    assert resp.status_code == 400
    user.refresh_from_db()
    assert user.check_password(DEFAULT_PASSWORD)
    assert settings.PASSWORD_RESET_TIMEOUT == 3600


def test_reset_does_not_disable_mfa(make_user):
    user = make_user()
    Authenticator.objects.create(user=user, type=Authenticator.Type.TOTP, data={"secret": "encrypted-in-real-use"})
    _request_reset(APIClient(), user.email)
    client = APIClient()
    client.post(AUTH + "password/reset", {"key": _reset_key(), "password": NEW_PASSWORD}, format="json")
    assert Authenticator.objects.filter(user=user, type=Authenticator.Type.TOTP).exists()
    login = APIClient().post(AUTH + "login", {"email": user.email, "password": NEW_PASSWORD}, format="json")
    # the new password is only the first factor: the second one is still demanded
    assert login.status_code == 401
    assert any(f["id"] == "mfa_authenticate" for f in login.json()["data"]["flows"])


def test_reset_rejects_weak_password(make_user):
    user = make_user("weakreset@example.com")
    _request_reset(APIClient(), user.email)
    key = _reset_key()
    for weak in ("short1!", "weakreset@example.com", "123456789012"):
        resp = APIClient().post(AUTH + "password/reset", {"key": key, "password": weak}, format="json")
        assert resp.status_code == 400, weak
    user.refresh_from_db()
    assert user.check_password(DEFAULT_PASSWORD)


def test_reset_requests_are_rate_limited_per_address(make_user, settings):
    from config.settings import base

    # Test settings switch allauth rate limits off; this test restores the production policy.
    settings.ACCOUNT_RATE_LIMITS = {"reset_password": base.ACCOUNT_RATE_LIMITS["reset_password"]}
    user = make_user()
    client = APIClient()
    statuses = [_request_reset(client, user.email).status_code for _ in range(5)]
    assert statuses[:3] == [200, 200, 200]
    assert 429 in statuses[3:]
