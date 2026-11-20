"""Keel on the workeasy360-sso connector: what the move must preserve (people linked and sessions opened by the
previous release), and what it adds - OpenID Connect Back-Channel Logout, for one device (``sid``) and for
"sign out everywhere" (``sub`` only)."""

from __future__ import annotations

import importlib
import io
import json
import time
from urllib.parse import parse_qs, urlsplit

import pytest
from django.apps import apps as django_apps
from django.contrib.sessions.models import Session
from django.core.checks import run_checks
from django.core.management import call_command
from rest_framework.test import APIClient
from workeasy360_sso.models import FederatedIdentity, ProductSession, ReceivedLogoutToken

from apps.accounts.models import ExternalIdentity, Membership, Organization, User
from apps.audit.models import AuditEvent
from apps.authz.actor import FEDERATED_AAL_SESSION_KEY, FEDERATED_SUBJECT_SESSION_KEY
from apps.core.tenancy.context import system_context, tenant_context
from apps.core.tenancy.middleware import ACTIVE_MEMBERSHIP_KEY
from tests.accounts import workeasy360_fake as fake
from tests.accounts.conftest import AUTH
from tests.factories import DEFAULT_PASSWORD

pytestmark = [pytest.mark.django_db, pytest.mark.security]

W360_ORG = "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c"
OTHER_W360_ORG = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
START = "/api/auth/workeasy360/start"
CALLBACK = "/api/auth/callback/workeasy360"
BACKCHANNEL = "/api/auth/workeasy360/backchannel-logout"
SESSION = "/api/v1/session/"


@pytest.fixture
def provider(settings):
    return fake.configure(settings, fake.FakeProvider())


def _error_of(resp) -> str | None:
    assert resp.status_code == 302
    location = resp["Location"]
    if not location.startswith("/login?"):
        return None
    return parse_qs(urlsplit(location).query)["sso_error"][0]


def _sign_in(client, provider, *, start_query: str = "", **claims):
    resp = client.get(START + start_query)
    assert resp.status_code == 302, resp.content
    code, state = provider.authorize(resp["Location"], **claims)
    return client.get(CALLBACK, {"code": code, "state": state})


def _signed_in_as(provider, **claims) -> APIClient:
    client = APIClient()
    assert _error_of(_sign_in(client, provider, **claims)) is None
    return client


def _platform() -> APIClient:
    """Workeasy360's server: no cookies, and the CSRF check enforced (the receiver needs none)."""
    return APIClient(enforce_csrf_checks=True)


def _deliver(token: str):
    return _platform().post(BACKCHANNEL, {"logout_token": token}, format="multipart")


def _signed_out(client) -> bool:
    return client.get(SESSION).status_code in (401, 403)


def _org(w360_id: str = W360_ORG) -> Organization:
    with system_context("test.lookup"):
        return Organization.objects.get(workeasy360_organization_id=w360_id)


# ----------------------------------------------------------------------------- what the move preserves


def test_a_person_linked_by_the_previous_release_signs_in_to_the_same_account(provider, make_user):
    """The previous release linked people in ExternalIdentity only; the connector's mirror does not exist yet
    for them. Their next sign-in finds the same Keel user, and the mirror is made then."""
    user = make_user("ada@example.com")
    ExternalIdentity.objects.create(user=user, issuer=fake.ISSUER, subject="w360-user-1")
    assert not FederatedIdentity.objects.exists()
    users_before = User.objects.count()

    client = _signed_in_as(provider, email="ada.renamed@example.com")  # the address changed at Workeasy360
    assert client.get(SESSION).json()["user"]["id"] == str(user.pk)
    assert User.objects.count() == users_before
    assert ExternalIdentity.objects.get(issuer=fake.ISSUER, subject="w360-user-1").user_id == user.pk
    mirror = FederatedIdentity.objects.get()
    assert (mirror.issuer, mirror.subject, mirror.user_id) == (fake.ISSUER, "w360-user-1", user.pk)
    assert ProductSession.objects.get().identity_id == mirror.pk


def test_a_disagreeing_mirror_is_corrected_from_external_identity(provider, make_user):
    """ExternalIdentity is authoritative: a mirror pointing elsewhere (a rollback, then a re-link) follows it."""
    ada = make_user("ada@example.com")
    stray = make_user("stray@example.com")
    ExternalIdentity.objects.create(user=ada, issuer=fake.ISSUER, subject="w360-user-1")
    FederatedIdentity.objects.create(user=stray, issuer=fake.ISSUER, subject="w360-user-1")
    client = _signed_in_as(provider)
    assert client.get(SESSION).json()["user"]["id"] == str(ada.pk)
    assert FederatedIdentity.objects.get(subject="w360-user-1").user_id == ada.pk


def test_the_backfill_migration_mirrors_every_identity_and_changes_none(make_user):
    migration = importlib.import_module("apps.accounts.migrations.0007_workeasy360_federated_identity_backfill")
    ada, grace, eve = make_user("ada@example.com"), make_user("grace@example.com"), make_user("eve@example.com")
    ExternalIdentity.objects.create(user=ada, issuer=fake.ISSUER, subject="s-ada", last_login_at=None)
    ExternalIdentity.objects.create(user=grace, issuer=fake.ISSUER, subject="s-grace")
    ExternalIdentity.objects.create(user=eve, issuer="https://other.example", subject="s-eve")
    FederatedIdentity.objects.create(user=grace, issuer=fake.ISSUER, subject="s-grace")  # already mirrored
    before = list(ExternalIdentity.objects.order_by("pk").values())

    migration.mirror_identities(django_apps, None)
    migration.mirror_identities(django_apps, None)  # idempotent

    assert list(ExternalIdentity.objects.order_by("pk").values()) == before
    mirrored = set(FederatedIdentity.objects.values_list("issuer", "subject", "user_id"))
    assert mirrored == {
        (fake.ISSUER, "s-ada", ada.pk),
        (fake.ISSUER, "s-grace", grace.pk),
        ("https://other.example", "s-eve", eve.pk),
    }


def _previous_release_session(user, membership, *, subject: str = "w360-user-1", aal: int = 1) -> APIClient:
    """A session as the previous release's callback left it: allauth's backend, Keel's federated keys and an
    authentication record - and no record of the connector's."""
    client = APIClient()
    client.force_login(user, backend="allauth.account.auth_backends.AuthenticationBackend")
    session = client.session
    session[ACTIVE_MEMBERSHIP_KEY] = str(membership.pk)
    session[FEDERATED_AAL_SESSION_KEY] = aal
    session[FEDERATED_SUBJECT_SESSION_KEY] = subject
    session["account_authentication_methods"] = [
        {"method": "workeasy360", "at": time.time(), "issuer": fake.ISSUER, "aal": aal, "auth_time": int(time.time())}
    ]
    session.save()
    return client


def test_a_session_opened_by_the_previous_release_keeps_working(provider):
    _signed_in_as(provider)  # creates Ada, her organization and owner membership
    ada = User.objects.get(email="ada@example.com")
    org = _org()
    with tenant_context(org.pk, reason="test.lookup"):
        membership = Membership.objects.get(user=ada)
    ProductSession.objects.all().delete()  # nothing of the connector's survives for the old session
    old = _previous_release_session(ada, membership)

    assert old.get("/api/v1/members/").status_code == 200
    session = old.get(SESSION).json()
    assert session["identity_provider"] == "workeasy360" and session["active"]["organization"]["id"] == str(org.pk)
    assert provider.entitlement_calls()[-1]["subject"] == "w360-user-1"  # still asked about per person
    # "Confirm it's you" still knows who is signed in here (from ExternalIdentity, not the connector's data).
    query = parse_qs(urlsplit(old.get(START + "?reauth=1")["Location"]).query)
    assert query["prompt"] == ["login"] and query["organization"] == [W360_ORG]


# ----------------------------------------------------------------------------- sign-in paths


def test_direct_sign_in_lets_workeasy360_choose_and_the_launcher_names_the_organization(provider):
    direct = APIClient()
    location = direct.get(START)["Location"]
    assert "organization" not in parse_qs(urlsplit(location).query)  # Workeasy360 shows its own chooser
    code, state = provider.authorize(location)
    assert _error_of(direct.get(CALLBACK, {"code": code, "state": state})) is None

    launched = APIClient()
    resp = _sign_in(launched, provider, start_query=f"?organization={OTHER_W360_ORG}", organization_id=OTHER_W360_ORG)
    assert _error_of(resp) is None
    assert launched.get(SESSION).json()["active"]["organization"]["id"] == str(_org(OTHER_W360_ORG).pk)


def test_the_session_is_bound_to_the_organization_the_token_names(provider):
    _signed_in_as(provider)  # Ada creates Analytical Engines
    _signed_in_as(provider, organization_id=OTHER_W360_ORG, organization_name="Other Co")  # ...and Other Co
    client = APIClient()
    resp = _sign_in(client, provider, start_query=f"?organization={OTHER_W360_ORG}", organization_id=OTHER_W360_ORG)
    assert _error_of(resp) is None
    other = _org(OTHER_W360_ORG)
    assert client.get(SESSION).json()["active"]["organization"]["id"] == str(other.pk)
    record = ProductSession.objects.get(session_key=client.session.session_key)
    assert str(record.organization_id) == OTHER_W360_ORG
    # Asked for one organization, answered for another: refused, and nobody is signed in.
    mismatch = APIClient()
    resp = _sign_in(mismatch, provider, start_query=f"?organization={OTHER_W360_ORG}", organization_id=W360_ORG)
    assert _error_of(resp) == "refused" and _signed_out(mismatch)


def test_two_tabs_signing_in_at_once_both_complete(provider):
    client = APIClient()
    first, second = client.get(START), client.get(START)
    assert "w360sso_bind" in first.cookies and "w360sso_bind" not in second.cookies  # one binding, shared
    code_1, state_1 = provider.authorize(first["Location"])
    code_2, state_2 = provider.authorize(second["Location"])
    assert _error_of(client.get(CALLBACK, {"code": code_2, "state": state_2})) is None
    assert _error_of(client.get(CALLBACK, {"code": code_1, "state": state_1})) is None
    assert not _signed_out(client)


def test_another_account_in_the_same_browser_replaces_the_session_server_side(provider):
    client = _signed_in_as(provider)
    ada_key = client.session.session_key
    ada_record = ProductSession.objects.get(session_key=ada_key)
    # "Use another account": a different person signs in in the same browser.
    assert _error_of(_sign_in(client, provider, sub="w360-user-2", email="grace@example.com")) is None
    assert client.get(SESSION).json()["user"]["email"] == "grace@example.com"
    assert not Session.objects.filter(session_key=ada_key).exists()  # Ada's session is gone, not inherited
    ada_record.refresh_from_db()
    assert ada_record.end_reason == ProductSession.EndReason.REPLACED
    thief = APIClient()
    thief.cookies["keel_session"] = ada_key
    assert _signed_out(thief)


def test_signing_in_again_as_the_same_person_continues_with_a_new_session_id(provider):
    client = _signed_in_as(provider)
    before = client.session.session_key
    assert _error_of(_sign_in(client, provider)) is None  # "Continue as Ada"
    assert client.session.session_key != before
    assert User.objects.filter(email="ada@example.com").count() == 1
    assert ProductSession.objects.filter(ended_at__isnull=True).count() == 1


# ----------------------------------------------------------------------------- sign-out


def test_signing_out_of_the_product_ends_its_session_record(provider):
    client = _signed_in_as(provider)
    key = client.session.session_key
    assert client.delete(AUTH + "session").status_code == 401  # allauth: signed out
    assert _signed_out(client)
    assert not Session.objects.filter(session_key=key).exists()
    record = ProductSession.objects.get(session_key=key)
    assert record.end_reason == ProductSession.EndReason.SIGNED_OUT


def test_a_password_sign_in_never_inherits_a_workeasy360_session_record(provider, make_user, make_org):
    """Hybrid mode: a password sign-in in a browser whose session still carries the connector's data (signed
    out of Keel's account, say, but not of the session) is not that Workeasy360 sign-in - the record is ended
    and the data dropped, so a Workeasy360 sign-out of that device cannot end the password session."""
    # An existing Keel account, linked by an operator to the Workeasy360 account; it keeps its password.
    bundle = make_org("Analytical Engines", owner=make_user("ada@example.com"))
    call_command("link_workeasy360_organization", str(bundle.org.pk), W360_ORG, stdout=io.StringIO())
    call_command(
        "link_workeasy360_user",
        "--email",
        "ada@example.com",
        "--subject",
        "w360-user-1",
        "--organization",
        W360_ORG,
        "--actor",
        "test",
        "--reason",
        "test",
        "--apply",
        stdout=io.StringIO(),
    )
    federated = _signed_in_as(provider, sid="sid-1")
    record = ProductSession.objects.get()
    leftover = dict(federated.session["workeasy360_sso"])

    client = APIClient()
    session = client.session
    session["workeasy360_sso"] = leftover
    session[FEDERATED_AAL_SESSION_KEY] = 2
    session.save()
    resp = client.post(AUTH + "login", {"email": "ada@example.com", "password": DEFAULT_PASSWORD}, format="json")
    assert resp.status_code == 200
    assert "workeasy360_sso" not in client.session and FEDERATED_AAL_SESSION_KEY not in client.session
    record.refresh_from_db()
    assert record.end_reason == ProductSession.EndReason.REPLACED
    assert _deliver(provider.logout_token(sid="sid-1")).status_code == 200
    assert not _signed_out(client)


# ----------------------------------------------------------------------------- back-channel logout


def test_a_device_logout_ends_only_that_devices_session(provider):
    laptop = _signed_in_as(provider, sid="sid-laptop")
    phone = _signed_in_as(provider, sid="sid-phone")
    laptop_key = laptop.session.session_key
    resp = _deliver(provider.logout_token(sub="w360-user-1", sid="sid-laptop"))
    assert resp.status_code == 200 and resp["Cache-Control"] == "no-store"
    assert _signed_out(laptop)
    assert not Session.objects.filter(session_key=laptop_key).exists()
    assert not _signed_out(phone)  # the same person's other device stays signed in
    assert ProductSession.objects.get(provider_sid="sid-laptop").end_reason == ProductSession.EndReason.BACKCHANNEL
    with system_context("test.audit"):
        assert AuditEvent.objects.filter(action="auth.logout", metadata__method="workeasy360_backchannel").count() == 1


def test_a_device_logout_follows_a_rotated_session_key(provider):
    """Switching organization rotates the session key; the back-channel record follows it."""
    _signed_in_as(provider, organization_id=OTHER_W360_ORG, organization_name="Other Co")
    client = _signed_in_as(provider, sid="sid-1")
    other = _org(OTHER_W360_ORG)
    with tenant_context(other.pk, reason="test.lookup"):
        membership = Membership.objects.get(user__email="ada@example.com")
    before = client.session.session_key
    assert client.post("/api/v1/session/switch-organization/", {"membership_id": str(membership.pk)}).status_code == 200
    assert client.session.session_key != before
    assert ProductSession.objects.get(provider_sid="sid-1").session_key == client.session.session_key
    assert _deliver(provider.logout_token(sid="sid-1")).status_code == 200
    assert _signed_out(client)


def test_sign_out_everywhere_ends_every_session_of_that_person_including_older_ones(provider):
    laptop = _signed_in_as(provider, sid="sid-laptop")
    phone = _signed_in_as(provider, sid="sid-phone")
    bystander = _signed_in_as(provider, sub="w360-user-2", email="grace@example.com", sid="sid-grace")
    ada = User.objects.get(email="ada@example.com")
    with tenant_context(_org().pk, reason="test.lookup"):
        membership = Membership.objects.get(user=ada)
    old = _previous_release_session(ada, membership)  # opened before this release: no connector record
    assert not _signed_out(old)

    assert _deliver(provider.logout_token(sub="w360-user-1")).status_code == 200
    assert _signed_out(laptop) and _signed_out(phone) and _signed_out(old)
    assert not _signed_out(bystander)
    with system_context("test.audit"):
        event = AuditEvent.objects.get(action="auth.sessions_revoked", actor_user_id=ada.pk)
    assert event.metadata["method"] == "workeasy360_backchannel" and event.metadata["sessions_ended"] == 2
    # Signing in again works as ever.
    assert not _signed_out(_signed_in_as(provider))


def test_a_logout_for_someone_unknown_here_is_accepted_and_ends_nothing(provider):
    client = _signed_in_as(provider)
    assert _deliver(provider.logout_token(sub="never-signed-in-here")).status_code == 200
    assert not _signed_out(client)


def test_a_replayed_logout_token_is_refused(provider):
    client = _signed_in_as(provider, sid="sid-1")
    token = provider.logout_token(sid="sid-1")
    assert _deliver(token).status_code == 200
    assert _signed_out(client)
    again = _signed_in_as(provider, sid="sid-2")
    replay = _deliver(token)
    assert replay.status_code == 400 and replay.json() == {"error": "invalid_request"}
    assert not _signed_out(again)


@pytest.mark.parametrize(
    "overrides",
    [
        {"aud": "another-client"},
        {"iss": "https://evil.example"},
        {"events": {"http://example.com/other": {}}},
        {"nonce": "n"},
        {"jti": None},
        {"exp": int(time.time()) - 600},
        {"iat": int(time.time()) - 3600, "exp": int(time.time()) + 60},
    ],
)
def test_a_logout_token_failing_any_check_is_refused_and_ends_nothing(provider, overrides):
    client = _signed_in_as(provider)
    resp = _deliver(provider.logout_token(sub="w360-user-1", **overrides))
    assert resp.status_code == 400
    assert not _signed_out(client)


def test_a_forged_logout_token_is_refused(provider):
    client = _signed_in_as(provider)
    forged = provider.logout_token(sub="w360-user-1", key=fake.rsa_key("stranger"))  # right kid, wrong key
    assert _deliver(forged).status_code == 400
    id_token = provider.id_token(nonce="n")  # an ID token is not a logout token
    assert _deliver(id_token).status_code == 400
    assert _deliver("not-a-jwt").status_code == 400
    assert not _signed_out(client)
    assert not ReceivedLogoutToken.objects.exists()


def test_the_receiver_takes_only_a_post(provider):
    assert APIClient().get(BACKCHANNEL).status_code == 405


def test_when_ending_sessions_fails_the_provider_is_asked_to_retry_and_the_retry_works(provider, monkeypatch):
    from apps.accounts import services

    client = _signed_in_as(provider, sid="sid-1")
    token = provider.logout_token(sub="w360-user-1")

    def broken(user):
        raise RuntimeError("database hiccup")

    monkeypatch.setattr(services, "revoke_user_sessions", broken)
    assert _deliver(token).status_code == 503
    assert not ReceivedLogoutToken.objects.exists()  # nothing was recorded: the retry is not a "replay"
    assert ProductSession.objects.get().ended_at is None
    monkeypatch.undo()
    assert _deliver(token).status_code == 200
    assert _signed_out(client)


def test_a_sign_in_in_flight_from_an_ended_workeasy360_session_is_refused(provider):
    client = APIClient()
    code, state = provider.authorize(client.get(START)["Location"], sid="sid-1")
    assert _deliver(provider.logout_token(sid="sid-1")).status_code == 200
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "expired"
    assert _signed_out(client)


# ----------------------------------------------------------------------------- configuration


def test_the_connector_checks_pass_and_the_callback_is_keels_own_route(provider):
    assert [m.id for m in run_checks() if m.id.startswith("workeasy360") and m.level >= 30] == []


def test_the_manifest_names_the_registered_redirect_uri_and_the_back_channel_uri(provider, settings):
    settings.WORKEASY360_SSO_ONLY = True
    out = io.StringIO()
    call_command("w360sso_manifest", stdout=out)
    manifest = json.loads(out.getvalue())
    assert manifest["redirect_uris"] == [fake.REDIRECT_URI]
    assert manifest["backchannel_logout_uri"] == "https://testserver/api/auth/workeasy360/backchannel-logout"


def test_an_ec_key_signs_its_assertions_with_es256(provider, settings):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from workeasy360_sso.conf import get_config

    key = ec.generate_private_key(ec.SECP256R1())
    settings.WORKEASY360_PRIVATE_KEY = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    config = get_config()
    assert config.signing_algorithm == "ES256" and config.problems == ()


def test_an_inline_key_with_escaped_newlines_is_accepted(provider, settings):
    """What production passes from SSM: one line, literal \\n escapes."""
    from workeasy360_sso.conf import get_config

    settings.WORKEASY360_PRIVATE_KEY = provider.client_private_pem.replace("\n", "\\n")
    assert get_config().problems == ()
    assert _error_of(_sign_in(APIClient(), provider)) is None


def test_the_redirect_uri_must_stay_keels_callback(provider, settings):
    settings.WORKEASY360_REDIRECT_URI = "https://testserver/api/auth/callback/elsewhere"
    assert "workeasy360_sso.E005" in {m.id for m in run_checks()}


def test_the_connector_cleanup_is_scheduled_and_purges_what_is_no_longer_needed(provider, settings):
    from datetime import timedelta

    from django.utils import timezone

    from apps.accounts.tasks import workeasy360_cleanup

    assert settings.CELERY_BEAT_SCHEDULE["accounts.workeasy360_cleanup"]["task"] == "accounts.workeasy360_cleanup"
    client = _signed_in_as(provider)
    live = ProductSession.objects.get()
    gone = ProductSession.objects.create(
        identity=live.identity, session_key="expired-long-ago", organization_id=live.organization_id
    )
    ProductSession.objects.filter(pk__in=[live.pk, gone.pk]).update(created_at=timezone.now() - timedelta(days=45))
    summary = workeasy360_cleanup.apply().get()
    assert "vanished_sessions=1" in summary
    assert list(ProductSession.objects.values_list("pk", flat=True)) == [live.pk]
    assert not _signed_out(client)
