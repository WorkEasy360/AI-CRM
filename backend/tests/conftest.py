from __future__ import annotations

import re
from urllib.parse import unquote

import pytest
from django.core import mail
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.core.tenancy.middleware import ACTIVE_MEMBERSHIP_KEY
from tests import factories


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def make_user(db):
    return factories.make_user


@pytest.fixture
def make_org(db):
    return factories.make_org


@pytest.fixture
def make_member(db):
    return factories.make_member


@pytest.fixture
def make_widget(db):
    return factories.make_widget


@pytest.fixture
def org_a(make_org):
    return make_org("Org A")


@pytest.fixture
def org_b(make_org):
    return make_org("Org B")


def _client_for(user, membership=None, *, enforce_csrf=False) -> APIClient:
    user.refresh_from_db()  # session hash depends on the current session_salt
    client = APIClient(enforce_csrf_checks=enforce_csrf)
    client.force_login(user)
    if membership is not None:
        session = client.session
        session[ACTIVE_MEMBERSHIP_KEY] = str(membership.pk)
        session.save()
    return client


@pytest.fixture
def client_for(db):
    return _client_for


@pytest.fixture
def owner_client(org_a, client_for):
    return client_for(org_a.owner, org_a.owner_membership)


@pytest.fixture
def anon_client():
    return APIClient()


def extract_link_key(body: str, path_fragment: str) -> str:
    match = re.search(rf"{re.escape(path_fragment)}([A-Za-z0-9_\-:.%]+)", body)
    assert match, f"no {path_fragment} link in email body:\n{body}"
    return unquote(match.group(1))


@pytest.fixture
def last_email():
    def _get():
        assert mail.outbox, "no email was sent"
        return mail.outbox[-1]

    return _get


@pytest.fixture
def reauthenticate():
    """Perform a real password re-authentication for a logged-in client (opens the recent-auth window)."""

    def _do(client, password: str = factories.DEFAULT_PASSWORD):
        resp = client.post("/_allauth/browser/v1/auth/reauthenticate", {"password": password}, format="json")
        assert resp.status_code == 200, resp.content
        return resp

    return _do
