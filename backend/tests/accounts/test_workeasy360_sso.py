"""Sign in with Workeasy360, end to end through Keel's views and the workeasy360-sso connector, against an
in-process provider."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time
import uuid
from io import StringIO
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from allauth.account.models import EmailAddress
from cryptography.fernet import Fernet
from django.core import mail
from django.core.checks import run_checks
from django.core.management import CommandError, call_command
from django.core.management.base import SystemCheckError
from rest_framework.test import APIClient
from workeasy360_sso import discovery
from workeasy360_sso.models import PendingSignIn

from apps.accounts import services
from apps.accounts.models import ExternalIdentity, Membership, Organization, User
from apps.accounts.workeasy360 import config, views
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
def provider(settings):
    return fake.configure(settings, fake.FakeProvider())


def _flow(location: str) -> PendingSignIn:
    """The connector's pending flow for the authorization request at ``location`` (it stores a hash of state)."""
    state = parse_qs(urlsplit(location).query)["state"][0]
    return PendingSignIn.objects.get(state_hash=hashlib.sha256(state.encode()).hexdigest())


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


def test_start_keeps_the_flow_server_side_and_redirects_with_the_organization(provider):
    client = APIClient()
    resp = client.get(START, {"organization": W360_ORG, "next": "/contacts?view=all"})
    assert resp.status_code == 302
    query = {k: v[0] for k, v in parse_qs(urlsplit(resp["Location"]).query).items()}
    assert query["organization"] == W360_ORG
    assert query["redirect_uri"] == fake.REDIRECT_URI
    flow = _flow(resp["Location"])  # single use, bound to this browser by a cookie; state stored only hashed
    assert flow.nonce == query["nonce"] and query["state"] not in flow.state_hash
    assert str(flow.organization_hint) == W360_ORG and flow.next_path == "/contacts?view=all"
    assert flow.code_verifier and flow.code_verifier not in resp["Location"]
    assert "w360sso_bind" in resp.cookies


@pytest.mark.parametrize("bad_next", ["https://evil.example/", "//evil.example", "/\\evil.example", "/login", "/a b"])
def test_start_drops_a_bad_organization_and_an_off_site_next(provider, bad_next):
    client = APIClient()
    resp = client.get(START, {"organization": "not-a-uuid", "next": bad_next})
    assert "organization" not in parse_qs(urlsplit(resp["Location"]).query)
    flow = _flow(resp["Location"])
    assert flow.organization_hint is None and flow.next_path == "/"


def test_use_another_account_asks_workeasy360_for_its_account_chooser(provider):
    client = APIClient()
    resp = client.get(START, {"prompt": "select_account", "next": "/deals"})
    assert parse_qs(urlsplit(resp["Location"]).query)["prompt"] == ["select_account"]
    assert _flow(resp["Location"]).prompt == "select_account"


@pytest.mark.parametrize("prompt", ["none", "login", "consent", "select_account login"])
def test_no_other_prompt_can_be_asked_for_by_a_visitor(provider, prompt):
    client = APIClient()
    resp = client.get(START, {"prompt": prompt})
    assert "prompt" not in parse_qs(urlsplit(resp["Location"]).query)


def test_next_never_carries_the_launcher_parameter_back(provider):
    client = APIClient()
    resp = client.get(START, {"next": f"/deals?organization={W360_ORG}"})
    assert _flow(resp["Location"]).next_path == "/deals"


def test_start_without_configuration_goes_back_to_login():
    resp = APIClient().get(START)
    assert _error_of(resp) == "unavailable"


# ----------------------------------------------------------------------------- signed-out marker (integration guide 6b)


def test_the_marker_is_named_like_the_csrf_cookie_host_prefixed_over_https_and_plain_over_http():
    assert views.SIGNED_OUT_MARKER_COOKIES == ("__Host-keel_signed_out", "keel_signed_out")


def test_a_successful_sign_in_clears_the_signed_out_marker_under_both_names(provider):
    """Signing out of WorkEasyCRM leaves a session cookie that stops the frontend from starting a Workeasy360
    sign-in by itself (frontend/src/lib/direct-sign-in.ts); the next successful sign-in removes it."""
    client = APIClient()
    for name in views.SIGNED_OUT_MARKER_COOKIES:
        client.cookies[name] = "1"
    resp = _sign_in(client, provider)
    assert resp.status_code == 302
    for name in views.SIGNED_OUT_MARKER_COOKIES:
        cleared = resp.cookies[name]
        assert cleared.value == "" and cleared["max-age"] == 0 and cleared["path"] == "/"
        assert cleared["samesite"] == "Lax" and not cleared["domain"]
    # A __Host- cookie can only be replaced by a Secure Set-Cookie, so its deletion carries the flag.
    assert resp.cookies["__Host-keel_signed_out"]["secure"] is True
    assert not resp.cookies["keel_signed_out"]["secure"]


def test_a_refused_sign_in_leaves_the_signed_out_marker_alone(provider):
    client = APIClient()
    for name in views.SIGNED_OUT_MARKER_COOKIES:
        client.cookies[name] = "1"
    resp = _sign_in(client, provider, email_verified=False)
    assert _error_of(resp) == "email_unverified"
    assert not set(views.SIGNED_OUT_MARKER_COOKIES) & set(resp.cookies)
    resp = client.get(CALLBACK, {"error": "access_denied", "state": "x"})
    assert _error_of(resp) == "cancelled"
    assert not set(views.SIGNED_OUT_MARKER_COOKIES) & set(resp.cookies)


def test_the_start_endpoint_never_sets_or_clears_the_marker(provider):
    """Starting is not signing in: the marker survives until a sign-in actually succeeds."""
    client = APIClient()
    for name in views.SIGNED_OUT_MARKER_COOKIES:
        client.cookies[name] = "1"
    resp = client.get(START, {"next": "/contacts"})
    assert resp.status_code == 302
    assert not set(views.SIGNED_OUT_MARKER_COOKIES) & set(resp.cookies)


# ----------------------------------------------------------------------------- product binding cannot be switched off


def _product_code_errors() -> list[str]:
    return [message.id for message in run_checks() if message.id == "workeasy360.E001"]


def test_the_product_code_defaults_to_easy_crm(settings):
    assert settings.WORKEASY360_PRODUCT_CODE == "easy_crm"


@pytest.mark.parametrize("blank", ["", "   ", "\t"])
def test_a_blank_product_code_is_a_system_check_error_where_sign_in_is_configured(provider, settings, blank):
    settings.WORKEASY360_PRODUCT_CODE = blank
    assert _product_code_errors() == ["workeasy360.E001"]
    with pytest.raises(SystemCheckError, match="WORKEASY360_PRODUCT_CODE"):
        call_command("check", stdout=StringIO(), stderr=StringIO())


def test_the_default_and_an_explicit_product_code_pass_the_check(provider, settings):
    assert _product_code_errors() == []
    call_command("check", stdout=StringIO(), stderr=StringIO())
    settings.WORKEASY360_PRODUCT_CODE = "easy_crm"
    assert _product_code_errors() == []


def test_a_blank_product_code_is_not_an_error_where_sign_in_is_not_configured(settings):
    assert not config.is_configured()
    settings.WORKEASY360_PRODUCT_CODE = ""
    assert _product_code_errors() == []


@pytest.mark.parametrize("claims", [{}, {"product_code": None}, {"product_code": "easy_helpdesk"}])
def test_a_blank_product_code_refuses_every_sign_in_instead_of_checking_nothing(provider, settings, claims):
    """If the startup checks were bypassed, an empty setting must not switch the comparison off: no sign-in
    starts, and one already under way when the setting went blank is refused at the callback."""
    client = APIClient()
    resp = client.get(START)
    code, state = provider.authorize(resp["Location"], **claims)
    settings.WORKEASY360_PRODUCT_CODE = ""
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "unavailable"
    assert _error_of(client.get(START)) == "unavailable"
    assert "_auth_user_id" not in client.session
    assert not User.objects.filter(email="ada@example.com").exists()


BACKEND_DIR = Path(__file__).resolve().parents[2]


def _import_production_settings(**overrides: str) -> subprocess.CompletedProcess[str]:
    """Import config.settings.prod in a clean interpreter, as gunicorn does, with a complete environment."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("WORKEASY360_")}
    env.update(
        ENVIRONMENT="staging",
        ALLOWED_HOSTS="crm.example.test",
        CSRF_TRUSTED_ORIGINS="https://crm.example.test",
        SECRET_KEY="k" * 60,
        MESSAGING_ENCRYPTION_KEYS=Fernet.generate_key().decode(),
        ALLOW_LOCAL_PRIVATE_STORAGE="true",
        DATABASE_URL="postgres://u:p@localhost:5433/keel",
        WORKEASY360_ISSUER="https://id.example.test",
        WORKEASY360_CLIENT_ID="client",
        WORKEASY360_REDIRECT_URI="https://crm.example.test/api/auth/callback/workeasy360",
        WORKEASY360_KEY_ID="key",
        WORKEASY360_PRIVATE_KEY="pem",
    )
    env.update(overrides)
    code = "import config.settings.prod as m; print('STARTED', repr(m.WORKEASY360_PRODUCT_CODE))"
    return subprocess.run(  # noqa: S603 - our own interpreter and a fixed program
        [sys.executable, "-c", code], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=120
    )


@pytest.mark.parametrize("blank", ["", "   "])
def test_production_refuses_to_start_with_a_blank_product_code(blank):
    done = _import_production_settings(WORKEASY360_PRODUCT_CODE=blank)
    assert done.returncode != 0 and "STARTED" not in done.stdout
    assert "WORKEASY360_PRODUCT_CODE must not be empty" in done.stderr


def test_production_starts_with_the_default_product_code():
    done = _import_production_settings()
    assert done.returncode == 0, done.stderr
    assert "STARTED 'easy_crm'" in done.stdout


def test_production_does_not_mind_a_blank_product_code_where_sign_in_is_not_configured():
    done = _import_production_settings(WORKEASY360_PRODUCT_CODE="", WORKEASY360_KEY_ID="", WORKEASY360_SSO_ONLY="false")
    assert done.returncode == 0, done.stderr


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


def _link_org(bundle, w360_id: str = W360_ORG) -> None:
    call_command("link_workeasy360_organization", str(bundle.org.pk), w360_id, stdout=StringIO())


def _linked_events(user: User) -> list[AuditEvent]:
    with system_context("test.audit"):
        events = AuditEvent.objects.filter(action="auth.sso_identity_linked", resource_type="externalidentity")
        return list(events.filter(metadata__user_id=str(user.pk)))


def _not_linked(user: User) -> bool:
    user.refresh_from_db()
    return not ExternalIdentity.objects.filter(user=user).exists() and user.check_password(DEFAULT_PASSWORD)


@pytest.fixture
def link_by_email(settings):
    settings.WORKEASY360_LINK_BY_VERIFIED_EMAIL = True


def test_email_linking_is_off_by_default():
    base = (Path(__file__).resolve().parents[2] / "config/settings/base.py").read_text(encoding="utf-8")
    assert 'env.bool("WORKEASY360_LINK_BY_VERIFIED_EMAIL", default=False)' in base
    assert config.link_by_verified_email() is False


def test_an_existing_account_with_the_address_is_refused_by_default(provider, make_user):
    user = make_user("ada@example.com")
    resp = _sign_in(APIClient(), provider)
    assert _error_of(resp) == "account_conflict"
    assert _not_linked(user)
    assert User.objects.filter(email__iexact="ada@example.com").count() == 1
    assert "auth.login_failed" in _actions(action="auth.login_failed")


def test_a_member_of_the_linked_organization_is_refused_by_default_too(provider, org_a):
    _link_org(org_a)
    resp = _sign_in(APIClient(), provider, email=org_a.owner.email)
    assert _error_of(resp) == "account_conflict"
    assert _not_linked(org_a.owner)
    assert _linked_events(org_a.owner) == []


def test_with_email_linking_on_a_verified_member_of_the_linked_organization_is_linked_and_audited(
    provider, org_a, link_by_email
):
    _link_org(org_a)
    client = APIClient()
    resp = _sign_in(client, provider, email=org_a.owner.email)
    assert _error_of(resp) is None
    identity = ExternalIdentity.objects.get(issuer=fake.ISSUER, subject="w360-user-1")
    assert identity.user_id == org_a.owner.pk
    org_a.owner.refresh_from_db()
    assert org_a.owner.check_password(DEFAULT_PASSWORD)  # the password is left as it is
    assert _membership(org_a.org, org_a.owner).role.key == "owner"
    assert client.get("/api/v1/session/").json()["active"]["organization"]["id"] == str(org_a.org.pk)
    [event] = _linked_events(org_a.owner)
    assert event.actor_user_id == org_a.owner.pk and event.organization_id == org_a.org.pk
    assert event.resource_id == str(identity.pk)
    assert event.metadata["link"] == "automatic"
    assert event.metadata["subject"] == "w360-user-1" and event.metadata["issuer"] == fake.ISSUER
    assert event.metadata["workeasy360_organization_id"] == W360_ORG and event.metadata["password_kept"] is True


def test_with_email_linking_on_an_account_only_in_another_organization_is_never_linked(
    provider, org_a, org_b, link_by_email
):
    _link_org(org_a)
    resp = _sign_in(APIClient(), provider, email=org_b.owner.email)
    assert _error_of(resp) == "account_conflict"
    assert _not_linked(org_b.owner)


def test_with_email_linking_on_an_account_also_in_another_organization_is_never_linked(
    provider, org_a, org_b, make_member, link_by_email
):
    _link_org(org_a)
    make_member(org_b, user=org_a.owner)
    resp = _sign_in(APIClient(), provider, email=org_a.owner.email)
    assert _error_of(resp) == "account_conflict"
    assert _not_linked(org_a.owner)


def test_with_email_linking_on_an_account_in_no_linked_organization_is_never_linked(
    provider, make_user, org_a, link_by_email
):
    lone = make_user("ada@example.com")
    assert _error_of(_sign_in(APIClient(), provider)) == "account_conflict"  # W360_ORG is linked to nothing
    assert _not_linked(lone)
    _link_org(org_a)
    assert _error_of(_sign_in(APIClient(), provider)) == "account_conflict"  # linked, but not a member
    assert _not_linked(lone)


def test_with_email_linking_on_an_already_linked_account_never_relinks(provider, org_a, link_by_email):
    _link_org(org_a)
    assert _error_of(_sign_in(APIClient(), provider, email=org_a.owner.email)) is None
    resp = _sign_in(APIClient(), provider, sub="someone-else", email=org_a.owner.email)
    assert _error_of(resp) == "account_conflict"
    assert list(ExternalIdentity.objects.filter(user=org_a.owner).values_list("subject", flat=True)) == ["w360-user-1"]
    assert len(_linked_events(org_a.owner)) == 1


def test_with_email_linking_on_an_account_keel_never_verified_is_not_linked(
    provider, org_a, make_member, make_user, link_by_email
):
    _link_org(org_a)
    squatter = make_user("ada@example.com", verified=False)
    make_member(org_a, user=squatter)
    assert _error_of(_sign_in(APIClient(), provider)) == "account_conflict"
    assert _not_linked(squatter)
    assert not EmailAddress.objects.get(user=squatter).verified


def test_with_email_linking_on_a_suspended_member_or_a_staff_account_is_not_linked(
    provider, org_a, make_member, make_user, link_by_email
):
    _link_org(org_a)
    suspended = make_member(org_a, user=make_user("ada@example.com")).user
    with tenant_context(org_a.org.pk, reason="test.suspend"):
        Membership.objects.filter(user=suspended).update(status=Membership.Status.SUSPENDED)
    assert _error_of(_sign_in(APIClient(), provider)) == "account_conflict"
    assert _not_linked(suspended)
    staff = make_member(org_a, user=make_user("grace@example.com")).user
    User.objects.filter(pk=staff.pk).update(is_staff=True)
    assert _error_of(_sign_in(APIClient(), provider, sub="w360-user-2", email="grace@example.com")) == (
        "account_conflict"
    )
    assert _not_linked(staff)


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


def test_token_without_a_product_code_is_refused_like_a_wrong_product(provider):
    """A token that does not say which product it is for is no evidence it is for this one."""
    client = APIClient()
    assert _error_of(_sign_in(client, provider, product_code=None)) == "wrong_product"
    assert "_auth_user_id" not in client.session
    assert not User.objects.filter(email="ada@example.com").exists()


@pytest.mark.parametrize("claims", [{"azp": "another-client"}, {"aud": [fake.CLIENT_ID, "another-client"]}])
def test_token_issued_to_another_client_is_refused(provider, claims):
    client = APIClient()
    assert _error_of(_sign_in(client, provider, **claims)) == "refused"
    assert "_auth_user_id" not in client.session
    assert not User.objects.filter(email="ada@example.com").exists()


def test_a_successful_callback_issues_a_new_session_key_so_a_planted_one_is_worthless(provider, settings):
    """Session fixation: whoever planted the session id a browser had before signing in must not be signed in
    by the sign-in. The key changes across the callback and the old one is gone."""
    client = APIClient()
    planted = client.session  # a session id the browser had (or was given) before signing in
    planted["planted"] = True
    planted.save()
    client.cookies[settings.SESSION_COOKIE_NAME] = planted.session_key
    resp = client.get(START)
    assert resp.status_code == 302
    before = client.session.session_key
    assert before == planted.session_key

    code, state = provider.authorize(resp["Location"])
    done = client.get(CALLBACK, {"code": code, "state": state})
    assert done.status_code == 302 and _error_of(done) is None

    after = client.session.session_key
    assert after and after != before
    assert client.get("/api/v1/session/").status_code == 200
    attacker = APIClient()
    attacker.cookies[settings.SESSION_COOKIE_NAME] = before
    refused = attacker.get("/api/v1/session/")
    assert refused.status_code in (401, 403) and "user" not in refused.json()


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
    PendingSignIn.objects.update(expires_at="2000-01-01T00:00:00Z")  # started an hour (and more) ago
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
    location = client.get(START)["Location"]
    state = parse_qs(urlsplit(location).query)["state"][0]
    resp = client.get(CALLBACK, {"error": error, "error_description": "<script>", "state": state})
    assert _error_of(resp) == expected
    assert _flow(location).consumed_at is not None  # the flow is spent


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
    settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI = fake.POST_LOGOUT_REDIRECT_URI
    resp = APIClient().get("/api/auth/workeasy360/logout")
    assert resp.status_code == 302
    assert resp["Location"].startswith(fake.END_SESSION + "?")
    query = {k: v[0] for k, v in parse_qs(urlsplit(resp["Location"]).query).items()}
    assert query == {"client_id": fake.CLIENT_ID, "post_logout_redirect_uri": fake.POST_LOGOUT_REDIRECT_URI}


def test_the_sign_out_link_changes_nothing_here(provider, settings):
    """A link to it cannot sign anyone out of Keel: the frontend ends Keel's session first, with a
    CSRF-protected write."""
    settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI = fake.POST_LOGOUT_REDIRECT_URI
    client = APIClient()
    _sign_in(client, provider)
    client.get("/api/auth/workeasy360/logout")
    assert client.get("/api/v1/session/").status_code == 200


def test_sign_out_of_workeasy360_falls_back_to_sign_in_when_unavailable(provider, settings):
    assert APIClient().get("/api/auth/workeasy360/logout")["Location"] == "/login"  # no post-logout URI
    settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI = fake.POST_LOGOUT_REDIRECT_URI
    provider.advertise_end_session = False
    discovery.reset_cache()  # rediscover
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
    settings.WORKEASY360_POST_LOGOUT_REDIRECT_URI = fake.POST_LOGOUT_REDIRECT_URI
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
    # The owner's account is not taken over by its address: an operator links the person first.
    assert _error_of(_sign_in(APIClient(), provider, email=org_a.owner.email)) == "account_conflict"
    _link_user(org_a.owner.email)
    # Their first Workeasy360 sign-in then lands in the existing organization with their role.
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


def _link_user(
    email: str, *, subject: str = "w360-user-1", organization: str = W360_ORG, apply: bool = True, **extra
) -> str:
    args = ["--email", email, "--subject", subject, "--organization", organization]
    args += ["--actor", extra.pop("actor", "Priya (support)"), "--reason", extra.pop("reason", "ticket 4711")]
    out = StringIO()
    call_command("link_workeasy360_user", *args, *(["--apply"] if apply else []), stdout=out, **extra)
    return out.getvalue()


def test_link_user_command_is_a_dry_run_without_apply(provider, org_a):
    _link_org(org_a)
    out = _link_user(org_a.owner.email, apply=False)
    assert "dry run" in out and f"organization={org_a.org.slug}" in out
    assert not ExternalIdentity.objects.filter(user=org_a.owner).exists()
    assert _linked_events(org_a.owner) == []


def test_link_user_command_links_audits_and_keeps_the_password(provider, org_a, org_b, make_member):
    from workeasy360_sso.models import FederatedIdentity

    _link_org(org_a)
    make_member(org_b, user=org_a.owner)  # an operator may vouch for an account in several organizations
    out = _link_user(org_a.owner.email)
    assert f"other organizations it opens: {org_b.org.slug} (active)" in out
    identity = ExternalIdentity.objects.get(issuer=fake.ISSUER, subject="w360-user-1")
    assert identity.user_id == org_a.owner.pk
    assert FederatedIdentity.objects.get(issuer=fake.ISSUER, subject="w360-user-1").user_id == org_a.owner.pk
    org_a.owner.refresh_from_db()
    assert org_a.owner.check_password(DEFAULT_PASSWORD)
    [event] = _linked_events(org_a.owner)
    assert event.actor_type == "system" and event.actor_user_id is None
    assert event.organization_id == org_a.org.pk and event.resource_id == str(identity.pk)
    assert event.metadata["link"] == "operator"
    assert event.metadata["actor"] == "Priya (support)" and event.metadata["reason"] == "ticket 4711"
    assert event.metadata["user_id"] == str(org_a.owner.pk) and event.metadata["subject"] == "w360-user-1"
    assert event.metadata["issuer"] == fake.ISSUER and event.metadata["workeasy360_organization_id"] == W360_ORG
    assert event.metadata["other_organizations"] == [f"{org_b.org.slug} (active)"]
    assert event.created_at is not None
    # The person then signs in as that account.
    client = APIClient()
    assert _error_of(_sign_in(client, provider, email="changed@example.com")) is None
    assert client.get("/api/v1/session/").json()["user"]["email"] == org_a.owner.email


def test_link_user_command_refuses_an_unknown_or_unlinked_organization_and_a_non_member(provider, org_a, org_b):
    with pytest.raises(CommandError, match="not linked to a Keel organization"):
        _link_user(org_a.owner.email)
    with pytest.raises(CommandError, match="must be a Workeasy360 organization id"):
        _link_user(org_a.owner.email, organization="nope")
    _link_org(org_a)
    with pytest.raises(CommandError, match="is not a member in"):
        _link_user(org_b.owner.email)
    with pytest.raises(CommandError, match="No Keel account matches"):
        _link_user("nobody@example.com")
    with tenant_context(org_a.org.pk, reason="test.suspend"):
        Membership.objects.filter(user=org_a.owner).update(status=Membership.Status.SUSPENDED)
    with pytest.raises(CommandError, match="is suspended in"):
        _link_user(org_a.owner.email)
    assert not ExternalIdentity.objects.exists() and _linked_events(org_a.owner) == []


def test_link_user_command_refuses_when_either_side_is_linked(provider, org_a, make_member, make_user):
    _link_org(org_a)
    other = make_member(org_a, user=make_user("grace@example.com")).user
    _link_user(org_a.owner.email)
    with pytest.raises(CommandError, match="already linked to a Workeasy360 identity"):
        _link_user(org_a.owner.email, subject="w360-user-2")
    with pytest.raises(CommandError, match="already linked to the Keel account"):
        _link_user(other.email, subject="w360-user-1")
    assert list(ExternalIdentity.objects.values_list("user_id", "subject")) == [(org_a.owner.pk, "w360-user-1")]
    assert len(_linked_events(org_a.owner)) == 1


@pytest.mark.parametrize("blank", [{"actor": "  "}, {"reason": ""}])
def test_link_user_command_needs_an_actor_and_a_reason(provider, org_a, blank):
    _link_org(org_a)
    with pytest.raises(CommandError, match="must not be blank"):
        _link_user(org_a.owner.email, **blank)
    assert not ExternalIdentity.objects.exists()


def test_link_user_command_needs_the_issuer_configured(org_a):
    _link_org(org_a)
    with pytest.raises(CommandError, match="WORKEASY360_ISSUER is not configured"):
        _link_user(org_a.owner.email)


def test_no_link_is_kept_without_its_audit_record(provider, org_a, monkeypatch, settings):
    from apps.audit import service as audit_service

    _link_org(org_a)
    monkeypatch.setattr(audit_service, "record", lambda *args, **kwargs: None)
    with pytest.raises(CommandError, match="audit record could not be written"):
        _link_user(org_a.owner.email)
    settings.WORKEASY360_LINK_BY_VERIFIED_EMAIL = True
    assert _error_of(_sign_in(APIClient(), provider, email=org_a.owner.email)) == "unavailable"
    assert not ExternalIdentity.objects.exists()
