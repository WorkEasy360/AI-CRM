"""Sign in with Workeasy360, end to end through the two views, against an in-process provider."""

from __future__ import annotations

import time
import uuid
from io import StringIO
from urllib.parse import parse_qs, urlsplit

import pytest
from allauth.account.models import EmailAddress
from django.core import mail
from django.core.management import CommandError, call_command
from rest_framework.test import APIClient

from apps.accounts import services
from apps.accounts.models import ExternalIdentity, Membership, Organization, User
from apps.accounts.workeasy360 import config
from apps.audit.models import AuditEvent
from apps.authz.actor import FEDERATED_AAL_SESSION_KEY
from apps.core.tenancy.context import system_context, tenant_context
from apps.core.tenancy.middleware import ACTIVE_MEMBERSHIP_KEY
from tests.accounts import workeasy360_fake as fake
from tests.accounts.conftest import ACCOUNT, AUTH
from tests.factories import DEFAULT_PASSWORD

pytestmark = [pytest.mark.django_db, pytest.mark.security]

W360_ORG = "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c"
START = "/api/auth/workeasy360/start"
CALLBACK = "/api/auth/callback/workeasy360"


@pytest.fixture
def provider(settings, monkeypatch):
    provider = fake.FakeProvider()
    settings.WORKEASY360_ISSUER = fake.ISSUER
    settings.WORKEASY360_CLIENT_ID = fake.CLIENT_ID
    settings.WORKEASY360_REDIRECT_URI = fake.REDIRECT_URI
    settings.WORKEASY360_KEY_ID = fake.CLIENT_KID
    settings.WORKEASY360_PRIVATE_KEY = provider.client_private_pem
    monkeypatch.setattr(config, "transport_override", provider.transport)
    return provider


@pytest.fixture
def sso_only(settings):
    settings.WORKEASY360_SSO_ONLY = True


def _sign_in(client, provider, *, start_query: str = "", **claims):
    """Start, approve at the fake provider, return the callback response."""
    resp = client.get(START + start_query)
    assert resp.status_code == 302, resp.content
    code, state = provider.authorize(resp["Location"], **claims)
    return client.get(CALLBACK, {"code": code, "state": state})


def _error_of(resp) -> str | None:
    assert resp.status_code == 302
    location = resp["Location"]
    if not location.startswith("/login?"):
        return None
    return parse_qs(urlsplit(location).query)["sso_error"][0]


def _org(w360_id: str = W360_ORG) -> Organization:
    with system_context("test.lookup"):
        return Organization.objects.get(workeasy360_organization_id=w360_id)


def _membership(org: Organization, user: User) -> Membership:
    with tenant_context(org.pk, reason="test.lookup"):
        return Membership.objects.select_related("role").get(user=user)


def _actions(**filters) -> list[str]:
    with system_context("test.audit"):
        return list(AuditEvent.objects.filter(**filters).order_by("created_at").values_list("action", flat=True))


# ----------------------------------------------------------------------------- start


def test_start_keeps_the_flow_in_the_session_and_redirects_with_the_organization(provider):
    client = APIClient()
    resp = client.get(START, {"organization": W360_ORG, "next": "/contacts?view=all"})
    assert resp.status_code == 302
    query = {k: v[0] for k, v in parse_qs(urlsplit(resp["Location"]).query).items()}
    assert query["organization"] == W360_ORG
    assert query["redirect_uri"] == fake.REDIRECT_URI
    [flow] = client.session["workeasy360_flows"]
    assert flow["state"] == query["state"] and flow["nonce"] == query["nonce"]
    assert flow["organization"] == W360_ORG and flow["next"] == "/contacts?view=all"
    assert "verifier" in flow and flow["verifier"] not in resp["Location"]


@pytest.mark.parametrize("bad_next", ["https://evil.example/", "//evil.example", "/\\evil.example", "/login", "/a b"])
def test_start_drops_a_bad_organization_and_an_off_site_next(provider, bad_next):
    client = APIClient()
    resp = client.get(START, {"organization": "not-a-uuid", "next": bad_next})
    assert "organization" not in parse_qs(urlsplit(resp["Location"]).query)
    [flow] = client.session["workeasy360_flows"]
    assert flow["organization"] == "" and flow["next"] == "/"


def test_next_never_carries_the_launcher_parameter_back(provider):
    client = APIClient()
    client.get(START, {"next": f"/deals?organization={W360_ORG}"})
    assert client.session["workeasy360_flows"][0]["next"] == "/deals"


def test_start_without_configuration_goes_back_to_login():
    resp = APIClient().get(START)
    assert _error_of(resp) == "unavailable"


# ----------------------------------------------------------------------------- callback: provisioning


def test_first_sign_in_creates_user_organization_and_owner_and_signs_in(provider):
    client = APIClient()
    resp = _sign_in(client, provider, start_query="?next=/deals")
    assert resp.status_code == 302 and resp["Location"] == "/deals"

    user = User.objects.get(email="ada@example.com")
    assert not user.has_usable_password()
    assert (user.first_name, user.last_name) == ("Ada", "Lovelace")
    assert EmailAddress.objects.get(user=user).verified
    identity = ExternalIdentity.objects.get(user=user)
    assert (identity.issuer, identity.subject) == (fake.ISSUER, "w360-user-1")
    org = _org()
    assert org.name == "Analytical Engines"
    membership = _membership(org, user)
    assert membership.role.key == "owner"
    assert client.session[ACTIVE_MEMBERSHIP_KEY] == str(membership.pk)

    session = client.get("/api/v1/session/").json()
    assert session["active"]["organization"]["id"] == str(org.pk)
    assert session["identity_provider"] == "workeasy360"
    assert session["recently_authenticated"] is True
    assert client.get("/api/v1/members/").status_code == 200
    actions = _actions(actor_user_id=user.pk)
    assert {"auth.sso_account_created", "org.created", "auth.login"} <= set(actions)
    with system_context("test.audit"):
        login = AuditEvent.objects.filter(action="auth.login", actor_user_id=user.pk).get()
    assert login.metadata["method"] == "workeasy360" and login.organization_id == org.pk


def test_second_person_joins_with_the_default_role(provider):
    _sign_in(APIClient(), provider)
    client = APIClient()
    resp = _sign_in(client, provider, sub="w360-user-2", email="grace@example.com", name="Grace Hopper")
    assert _error_of(resp) is None
    grace = User.objects.get(email="grace@example.com")
    assert _membership(_org(), grace).role.key == "sales_rep"
    with system_context("test.count"):
        assert Organization.objects.filter(workeasy360_organization_id=W360_ORG).count() == 1


def test_returning_user_is_recognised_by_subject_even_after_an_email_change(provider):
    _sign_in(APIClient(), provider)
    resp = _sign_in(APIClient(), provider, email="ada.new@example.com")
    assert _error_of(resp) is None
    assert User.objects.filter(email__in=["ada@example.com", "ada.new@example.com"]).count() == 1


def test_existing_account_is_linked_by_verified_email_and_keeps_its_password(provider, make_user):
    user = make_user("ada@example.com")
    resp = _sign_in(APIClient(), provider)
    assert _error_of(resp) is None
    assert ExternalIdentity.objects.get(issuer=fake.ISSUER, subject="w360-user-1").user_id == user.pk
    user.refresh_from_db()
    assert user.check_password(DEFAULT_PASSWORD)
    assert "auth.sso_identity_linked" in _actions(actor_user_id=user.pk)


def test_linking_an_account_keel_never_verified_removes_its_password(provider, make_user):
    squatter = make_user("ada@example.com", verified=False)
    assert _error_of(_sign_in(APIClient(), provider)) is None
    squatter.refresh_from_db()
    assert not squatter.has_usable_password()
    assert EmailAddress.objects.get(user=squatter).verified


def test_unverified_email_at_the_provider_never_takes_over_an_account(provider, make_user):
    user = make_user("ada@example.com")
    resp = _sign_in(APIClient(), provider, email_verified=False)
    assert _error_of(resp) == "email_unverified"
    assert not ExternalIdentity.objects.filter(user=user).exists()
    assert "auth.login_failed" in _actions(action="auth.login_failed")


def test_unverified_email_never_creates_an_account(provider):
    assert _error_of(_sign_in(APIClient(), provider, email_verified=False)) == "email_unverified"
    assert not User.objects.filter(email="ada@example.com").exists()


def test_account_linked_to_another_workeasy360_identity_is_refused(provider):
    _sign_in(APIClient(), provider)
    resp = _sign_in(APIClient(), provider, sub="someone-else")
    assert _error_of(resp) == "account_conflict"


def test_missing_email_claim_is_refused(provider):
    assert _error_of(_sign_in(APIClient(), provider, email=None)) == "email_missing"


def test_token_for_another_product_is_refused(provider):
    assert _error_of(_sign_in(APIClient(), provider, product_code="easy_helpdesk")) == "wrong_product"


def test_suspended_keel_membership_is_refused(provider, make_user):
    _sign_in(APIClient(), provider)
    _sign_in(APIClient(), provider, sub="w360-user-2", email="grace@example.com")
    grace = User.objects.get(email="grace@example.com")
    org = _org()
    with tenant_context(org.pk, reason="test.suspend"):
        Membership.objects.filter(user=grace).update(status=Membership.Status.SUSPENDED)
    resp = _sign_in(APIClient(), provider, sub="w360-user-2", email="grace@example.com")
    assert _error_of(resp) == "membership_inactive"


def test_suspended_keel_organization_is_refused(provider):
    _sign_in(APIClient(), provider)
    with system_context("test.suspend"):
        Organization.objects.filter(workeasy360_organization_id=W360_ORG).update(status="suspended")
    assert _error_of(_sign_in(APIClient(), provider)) == "organization_unavailable"


def test_deactivated_keel_account_is_refused(provider):
    _sign_in(APIClient(), provider)
    User.objects.filter(email="ada@example.com").update(is_active=False)
    assert _error_of(_sign_in(APIClient(), provider)) == "account_disabled"


def test_answer_for_another_organization_than_requested_is_refused(provider):
    other = str(uuid.uuid4())
    resp = _sign_in(APIClient(), provider, start_query=f"?organization={other}")
    assert _error_of(resp) == "refused"


def test_signing_in_while_signed_in_as_someone_else_switches_user(provider, org_a, client_for):
    client = client_for(org_a.owner, org_a.owner_membership)
    assert _error_of(_sign_in(client, provider)) is None
    assert client.get("/api/v1/session/").json()["user"]["email"] == "ada@example.com"


def test_seat_limit_of_the_keel_plan_applies(provider, settings):
    _sign_in(APIClient(), provider)
    with system_context("test.plan"):
        Organization.objects.filter(workeasy360_organization_id=W360_ORG).update(settings={"max_users": 1})
    resp = _sign_in(APIClient(), provider, sub="w360-user-2", email="grace@example.com")
    assert _error_of(resp) == "seat_limit"


# ----------------------------------------------------------------------------- callback: protocol failures


def test_a_callback_is_good_once(provider):
    client = APIClient()
    resp = client.get(START)
    code, state = provider.authorize(resp["Location"])
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) is None
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "expired"


def test_callback_without_a_pending_flow_is_refused(provider):
    other_browser = APIClient()
    resp = APIClient().get(START)
    code, state = provider.authorize(resp["Location"])
    assert _error_of(other_browser.get(CALLBACK, {"code": code, "state": state})) == "expired"
    assert not User.objects.filter(email="ada@example.com").exists()


def test_an_expired_flow_is_refused(provider, monkeypatch):
    client = APIClient()
    resp = client.get(START)
    code, state = provider.authorize(resp["Location"])
    session = client.session
    session["workeasy360_flows"][0]["at"] = time.time() - 3600
    session.save()
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "expired"


def test_two_tabs_can_sign_in_at_once(provider):
    client = APIClient()
    first = client.get(START)
    second = client.get(START)
    code, state = provider.authorize(first["Location"])
    provider.authorize(second["Location"])
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) is None


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        ("access_denied", "cancelled"),
        ("login_required", "expired"),
        ("product_not_entitled", "not_entitled"),
        ("product_no_seat", "no_seat"),
        ("membership_inactive", "provider_membership_inactive"),
        ("organization_inactive", "organization_inactive"),
        ("access_policy_denied", "access_policy"),
        ("temporarily_unavailable", "unavailable"),
        ("unauthorized_client", "unavailable"),
        ("interaction_required", "expired"),
        ("something_new", "refused"),
    ],
)
def test_provider_error_parameters_map_to_the_fixed_vocabulary(provider, error, expected):
    client = APIClient()
    state = parse_qs(urlsplit(client.get(START)["Location"]).query)["state"][0]
    resp = client.get(CALLBACK, {"error": error, "error_description": "<script>", "state": state})
    assert _error_of(resp) == expected
    assert client.session["workeasy360_flows"] == []  # the flow is spent


def test_invalid_grant_sends_the_user_back_to_try_again(provider):
    client = APIClient()
    resp = client.get(START)
    _code, state = provider.authorize(resp["Location"])
    assert _error_of(client.get(CALLBACK, {"code": "not-issued", "state": state})) == "refused"


def test_provider_outage_is_reported_as_unavailable(provider):
    client = APIClient()
    resp = client.get(START)
    code, state = provider.authorize(resp["Location"])
    provider.token_status, provider.token_error = 503, "temporarily_unavailable"
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "unavailable"


# ----------------------------------------------------------------------------- MFA and re-authentication


def _require_mfa():
    org = _org()
    with system_context("test.mfa"):
        Organization.objects.filter(pk=org.pk).update(settings={"require_mfa": True})


def test_aal2_satisfies_the_organization_mfa_requirement(provider):
    _sign_in(APIClient(), provider)
    _require_mfa()
    client = APIClient()
    _sign_in(client, provider, aal=2)
    assert client.session[FEDERATED_AAL_SESSION_KEY] == 2
    assert client.get("/api/v1/members/").status_code == 200
    assert client.get("/api/v1/session/").json()["active"]["mfa_required"] is False


def test_aal1_does_not_satisfy_it_even_with_a_keel_authenticator(provider):
    from allauth.mfa.models import Authenticator

    _sign_in(APIClient(), provider)
    _require_mfa()
    Authenticator.objects.create(user=User.objects.get(email="ada@example.com"), type="totp", data={})
    client = APIClient()
    _sign_in(client, provider, aal=1)
    resp = client.get("/api/v1/members/")
    assert resp.status_code == 403 and resp.json()["type"] == "mfa_required"
    assert client.get("/api/v1/session/").json()["active"]["mfa_required"] is True


def test_a_workeasy360_session_must_sign_in_again_for_sensitive_actions(provider):
    client = APIClient()
    _sign_in(client, provider)
    assert client.patch("/api/v1/organizations/current/", {"name": "Renamed"}, format="json").status_code == 200

    _age_newest_record(client, 3600)
    resp = client.patch("/api/v1/organizations/current/", {"name": "Again"}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "reauth_required"
    assert client.get("/api/v1/session/").json()["recently_authenticated"] is False

    _sign_in(client, provider, start_query="?reauth=1")  # "Confirm with Workeasy360"
    assert client.patch("/api/v1/organizations/current/", {"name": "Again"}, format="json").status_code == 200


def test_confirm_with_workeasy360_asks_for_a_fresh_sign_in(provider):
    client = APIClient()
    _sign_in(client, provider)  # someone to confirm
    query = parse_qs(urlsplit(client.get(START + "?reauth=1")["Location"]).query)
    assert query["prompt"] == ["login"]
    assert "prompt" not in parse_qs(urlsplit(APIClient().get(START)["Location"]).query)


def test_a_confirmation_without_a_fresh_sign_in_is_refused(provider):
    """A round trip on a still-open Workeasy360 session proves nothing: the ID token's auth_time must
    not predate the confirmation request."""
    client = APIClient()
    _sign_in(client, provider)
    _age_newest_record(client, 3600)
    stale = _sign_in(client, provider, start_query="?reauth=1", auth_time=int(time.time()) - 3600)
    assert _error_of(stale) == "reauthentication_failed"
    assert client.get("/api/v1/session/").json()["recently_authenticated"] is False
    resp = client.patch("/api/v1/organizations/current/", {"name": "Again"}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "reauth_required"


def test_a_fresh_confirmation_allows_the_sensitive_action(provider):
    client = APIClient()
    _sign_in(client, provider)
    _age_newest_record(client, 3600)
    assert _error_of(_sign_in(client, provider, start_query="?reauth=1")) is None
    assert client.get("/api/v1/session/").json()["recently_authenticated"] is True
    assert client.patch("/api/v1/organizations/current/", {"name": "Again"}, format="json").status_code == 200


def test_confirm_with_workeasy360_names_the_current_organization(provider):
    """So Workeasy360 shows no organization chooser, and the confirmation is for this organization."""
    client = APIClient()
    _sign_in(client, provider)
    query = parse_qs(urlsplit(client.get(START + "?reauth=1")["Location"]).query)
    assert query["organization"] == [W360_ORG] and query["prompt"] == ["login"]


def test_a_confirmation_by_another_workeasy360_account_is_refused_and_switches_nobody(provider):
    """Someone else's password confirms nothing about the person signed in here - and silently switching
    accounts in the middle of "Confirm it's you" would be worse."""
    client = APIClient()
    _sign_in(client, provider)
    _age_newest_record(client, 3600)
    other = _sign_in(client, provider, start_query="?reauth=1", sub="w360-user-2", email="eve@example.com")
    assert _error_of(other) == "reauthentication_wrong_account"
    session = client.get("/api/v1/session/").json()
    assert session["user"]["email"] == "ada@example.com" and session["recently_authenticated"] is False
    resp = client.patch("/api/v1/organizations/current/", {"name": "Again"}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "reauth_required"
    assert not User.objects.filter(email="eve@example.com").exists()


def test_confirm_with_workeasy360_needs_someone_linked_to_confirm(provider, org_a, client_for):
    """A Keel-only account has no Workeasy360 account to confirm: refused at the start, so an unbound
    confirmation can never sign in whoever answers."""
    resp = client_for(org_a.owner, org_a.owner_membership).get(START + "?reauth=1")
    assert _error_of(resp) == "reauthentication_failed"


def test_a_workeasy360_sign_in_without_auth_time_is_not_a_recent_authentication(provider):
    client = APIClient()
    assert _error_of(_sign_in(client, provider, auth_time=None)) is None
    assert client.get("/api/v1/session/").json()["recently_authenticated"] is False


def test_a_workeasy360_account_gets_no_local_password_even_with_password_sign_in_on(provider):
    """Hybrid mode: a password set here would be a second way in that skips Workeasy360's MFA and policy.
    allauth would not even ask for a current password for an account Workeasy360 created."""
    client = APIClient()
    _sign_in(client, provider)
    resp = client.post(ACCOUNT + "password/change", {"new_password": "An0ther-Str0ng-Pass!"}, format="json")
    assert resp.status_code == 400
    user = User.objects.get(email="ada@example.com")
    assert not user.has_usable_password()
    mail.outbox.clear()
    assert APIClient().post(AUTH + "password/request", {"email": user.email}, format="json").status_code in (200, 401)
    assert mail.outbox == []


def test_a_silent_sign_in_on_an_old_workeasy360_session_is_not_a_recent_authentication(provider):
    """Recent means the password was entered recently at Workeasy360 (auth_time), not that Keel
    received a token a moment ago."""
    client = APIClient()
    assert _error_of(_sign_in(client, provider, auth_time=int(time.time()) - 3600)) is None
    assert client.get("/api/v1/session/").json()["recently_authenticated"] is False
    resp = client.patch("/api/v1/organizations/current/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 403 and resp.json()["type"] == "reauth_required"


def _age_newest_record(client, seconds: int) -> None:
    session = client.session
    records = session["account_authentication_methods"]
    records[-1]["at"] = time.time() - seconds
    if records[-1].get("auth_time") is not None:
        records[-1]["auth_time"] = int(time.time()) - seconds
    session["account_authentication_methods"] = records
    session.save()


# ----------------------------------------------------------------------------- sign out of Workeasy360


def test_sign_out_of_workeasy360_goes_to_its_confirmation_with_the_registered_uri(provider, settings):
    settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI = "http://testserver/login"
    resp = APIClient().get("/api/auth/workeasy360/logout")
    assert resp.status_code == 302
    assert resp["Location"].startswith(fake.END_SESSION + "?")
    query = {k: v[0] for k, v in parse_qs(urlsplit(resp["Location"]).query).items()}
    assert query == {"client_id": fake.CLIENT_ID, "post_logout_redirect_uri": "http://testserver/login"}


def test_the_sign_out_link_changes_nothing_here(provider, settings):
    """A link to it cannot sign anyone out of Keel: the frontend ends Keel's session first, with a
    CSRF-protected write."""
    settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI = "http://testserver/login"
    client = APIClient()
    _sign_in(client, provider)
    client.get("/api/auth/workeasy360/logout")
    assert client.get("/api/v1/session/").status_code == 200


def test_sign_out_of_workeasy360_falls_back_to_sign_in_when_unavailable(provider, settings):
    assert APIClient().get("/api/auth/workeasy360/logout")["Location"] == "/login"  # no post-logout URI
    settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI = "http://testserver/login"
    provider.advertise_end_session = False
    from apps.accounts.workeasy360 import config as cfg

    cfg._cached = None  # rediscover
    assert APIClient().get("/api/auth/workeasy360/logout")["Location"] == "/login"


def test_a_password_sign_in_never_inherits_a_federated_assurance_level(make_user):
    user = make_user()
    client = APIClient()
    session = client.session
    session[FEDERATED_AAL_SESSION_KEY] = 2  # left over in the browser's (anonymous) session
    session.save()
    resp = client.post(AUTH + "login", {"email": user.email, "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 200
    assert FEDERATED_AAL_SESSION_KEY not in client.session
    assert client.get("/api/v1/session/").json()["identity_provider"] is None


# ----------------------------------------------------------------------------- SSO only


def test_auth_methods_endpoint(provider, settings):
    assert APIClient().get("/api/v1/auth/methods/").json() == {
        "password": True,
        "workeasy360": True,
        "workeasy360_sign_out": False,
    }
    settings.WORKEASY360_SSO_ONLY = True
    settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI = "http://testserver/login"
    assert APIClient().get("/api/v1/auth/methods/").json() == {
        "password": False,
        "workeasy360": True,
        "workeasy360_sign_out": True,
    }
    settings.WORKEASY360_ISSUER = ""
    assert APIClient().get("/api/v1/auth/methods/").json() == {
        "password": False,
        "workeasy360": False,
        "workeasy360_sign_out": False,
    }


def test_sso_only_refuses_password_sign_in_before_checking_the_password(sso_only, make_user):
    user = make_user()
    for password in (DEFAULT_PASSWORD, "wrong-password"):
        resp = APIClient().post(AUTH + "login", {"email": user.email, "password": password}, format="json")
        assert resp.status_code == 400
        assert resp.json()["errors"][0]["code"] == "password_login_disabled"


def test_sso_only_refuses_sign_up(sso_only):
    resp = APIClient().post(AUTH + "signup", {"email": "new@example.com", "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 403
    assert not User.objects.filter(email="new@example.com").exists()


def test_sso_only_refuses_password_reauthentication(org_a, client_for, sso_only):
    client = client_for(org_a.owner, org_a.owner_membership)
    resp = client.post(AUTH + "reauthenticate", {"password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 400


def test_sso_only_issues_no_password_reset_links(sso_only, make_user):
    user = make_user()
    known = APIClient().post(AUTH + "password/request", {"email": user.email}, format="json")
    unknown = APIClient().post(AUTH + "password/request", {"email": "nobody@example.com"}, format="json")
    assert known.status_code == unknown.status_code == 200
    assert mail.outbox == []


def test_sso_only_refuses_invitation_sign_up(org_a, sso_only):
    from tests.factories import make_invitation

    make_invitation(org_a, email="invitee@example.com")
    token = "irrelevant-the-mode-is-checked-first"
    resp = APIClient().post(
        "/api/v1/invitations/register/", {"token": token, "name": "X", "password": DEFAULT_PASSWORD}, format="json"
    )
    assert resp.status_code == 403
    assert resp.json()["type"] == "password_sign_in_disabled"


def test_sso_only_refuses_self_service_organizations(org_a, client_for, sso_only):
    client = client_for(org_a.owner, org_a.owner_membership)
    resp = client.post("/api/v1/organizations/", {"name": "Side project"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["type"] == "organizations_managed_externally"


def test_sso_only_creates_no_personal_workspace(sso_only, make_user):
    user = make_user()
    assert services.ensure_personal_organization(user) is None
    with system_context("test.count"):
        assert not Membership.identity.for_user(user).exists()


def test_sso_only_workeasy360_sign_in_works_and_creates_only_the_workeasy360_organization(sso_only, provider):
    client = APIClient()
    assert _error_of(_sign_in(client, provider)) is None
    user = User.objects.get(email="ada@example.com")
    with system_context("test.count"):
        assert Membership.identity.for_user(user).count() == 1
    assert client.get("/api/v1/session/").json()["active"]["organization"]["name"] == "Analytical Engines"


# ----------------------------------------------------------------------------- operator command


def test_link_command_attaches_an_existing_organization(provider, org_a):
    call_command("link_workeasy360_organization", org_a.org.slug, W360_ORG, stdout=StringIO())
    assert _org().pk == org_a.org.pk
    # The owner's first Workeasy360 sign-in lands in the existing organization with their role.
    resp = _sign_in(APIClient(), provider, email=org_a.owner.email)
    assert _error_of(resp) is None
    assert _membership(org_a.org, org_a.owner).role.key == "owner"
    assert ExternalIdentity.objects.get(subject="w360-user-1").user_id == org_a.owner.pk


def test_link_command_refuses_when_either_side_is_linked(org_a, org_b):
    call_command("link_workeasy360_organization", str(org_a.org.pk), W360_ORG, stdout=StringIO())
    with pytest.raises(CommandError, match="already linked to Workeasy360"):
        call_command("link_workeasy360_organization", org_a.org.slug, str(uuid.uuid4()), stdout=StringIO())
    with pytest.raises(CommandError, match="already linked to"):
        call_command("link_workeasy360_organization", org_b.org.slug, W360_ORG, stdout=StringIO())
    with pytest.raises(CommandError, match="must be a UUID"):
        call_command("link_workeasy360_organization", org_b.org.slug, "nope", stdout=StringIO())
