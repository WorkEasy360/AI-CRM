"""AUTO_LOGIN: the development switch that opens the CRM without a sign-in page.

It replaces authentication with "whoever asks is the auto-login user", so the tests that matter
are the gates: off by default, refused in a deployed environment, and never overriding an API
credential. The happy path checks that the session it opens is a normal one (user, workspace,
active membership, audit trail) rather than a bypass of the tenancy layer.
"""

from __future__ import annotations

import pytest
from django.test import Client, override_settings

from apps.accounts.middleware import auto_login_enabled
from apps.accounts.models import Membership, User
from apps.audit.models import AuditEvent
from apps.core.tenancy.context import system_context

pytestmark = pytest.mark.django_db

SESSION_URL = "/api/v1/session/"
AUTO_EMAIL = "auto@keel.local"

dev_auto_login = override_settings(AUTO_LOGIN_ENABLED=True, AUTO_LOGIN_EMAIL=AUTO_EMAIL, ENVIRONMENT="development")


def test_disabled_by_default_keeps_the_api_unauthenticated(client: Client):
    assert auto_login_enabled() is False
    assert client.get(SESSION_URL).status_code == 403


@pytest.mark.parametrize("environment", ["production", "staging"])
def test_refused_in_a_deployed_environment(client: Client, environment: str):
    with override_settings(AUTO_LOGIN_ENABLED=True, AUTO_LOGIN_EMAIL=AUTO_EMAIL, ENVIRONMENT=environment):
        assert auto_login_enabled() is False
        assert client.get(SESSION_URL).status_code == 403
        assert not User.objects.filter(email__iexact=AUTO_EMAIL).exists()


@dev_auto_login
def test_opens_a_working_session_with_a_workspace(client: Client):
    response = client.get(SESSION_URL)

    assert response.status_code == 200, response.content
    payload = response.json()
    assert payload["user"]["email"] == AUTO_EMAIL
    # An active organization, so the CRM renders instead of asking for a setup step.
    assert payload["active"] is not None
    assert payload["active"]["role"]["key"] == "owner"

    user = User.objects.get(email__iexact=AUTO_EMAIL)
    assert not user.has_usable_password()  # cannot be signed into through the password flow
    with system_context("test.auto_login"):
        assert Membership.identity.for_user(user).active().count() == 1
        assert AuditEvent.objects.filter(action="auth.login", metadata__method="auto_login").count() == 1


@dev_auto_login
def test_reuses_the_same_account_and_session_across_requests(client: Client):
    first = client.get(SESSION_URL).json()
    second = client.get(SESSION_URL).json()

    assert first["user"]["id"] == second["user"]["id"]
    assert User.objects.filter(email__iexact=AUTO_EMAIL).count() == 1
    with system_context("test.auto_login"):
        # The second request rode the existing session; only the first one signed in.
        assert AuditEvent.objects.filter(action="auth.login").count() == 1


@dev_auto_login
def test_only_signs_in_on_safe_methods(client: Client):
    # Signing in here would rotate the CSRF token before CsrfViewMiddleware validates the request.
    assert client.post("/api/v1/session/bootstrap/").status_code in {403, 405}
    assert not User.objects.filter(email__iexact=AUTO_EMAIL).exists()

    assert client.get(SESSION_URL).status_code == 200
    assert client.post("/api/v1/session/bootstrap/").status_code == 200


@dev_auto_login
def test_does_not_replace_an_already_authenticated_user(client: Client, make_user, make_org):
    owner = make_user(email="real.person@example.com")
    make_org(owner=owner)
    client.force_login(owner)

    payload = client.get(SESSION_URL).json()

    assert payload["user"]["email"] == "real.person@example.com"
    assert not User.objects.filter(email__iexact=AUTO_EMAIL).exists()
