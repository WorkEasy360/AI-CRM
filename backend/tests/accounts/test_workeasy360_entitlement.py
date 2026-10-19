"""Workeasy360 entitlement, re-checked while Keel's own session lives on (entitlement.py): an organization
whose access has ended is refused within Workeasy360's cadence, never because of an outage."""

from __future__ import annotations

import time

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.accounts.models import Organization
from apps.accounts.workeasy360 import config, entitlement
from apps.core.tenancy.context import system_context
from tests.accounts import workeasy360_fake as fake

pytestmark = [pytest.mark.django_db, pytest.mark.security]

W360_ORG = "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c"
SUBJECT = "w360-user-1"  # the ``sub`` the fake provider signs people in with
START = "/api/auth/workeasy360/start"
CALLBACK = "/api/auth/callback/workeasy360"
DATA = "/api/v1/members/"


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


def _signed_in(provider) -> APIClient:
    client = APIClient()
    resp = client.get(START)
    code, state = provider.authorize(resp["Location"])
    assert client.get(CALLBACK, {"code": code, "state": state}).status_code == 302
    return client


def _age_answer(seconds: int) -> None:
    key = entitlement._key(W360_ORG, SUBJECT)
    record = cache.get(key)
    record["checked_at"] -= seconds
    cache.set(key, record, entitlement.LAST_KNOWN_KEEP_SECONDS)


def _type(resp) -> str:
    return resp.json().get("type", "")


def test_the_organization_is_asked_about_once_per_window_and_only_by_the_client(provider):
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    assert client.get(DATA).status_code == 200
    calls = provider.entitlement_calls()
    assert len(calls) == 1
    assert calls[0]["organization_id"] == W360_ORG
    assert calls[0]["subject"] == SUBJECT  # a signed-in request asks about the person it is for
    assert "product_code" not in calls[0]  # the product is the authenticated client


def test_access_ends_when_workeasy360_says_it_has_ended(provider):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_ENDED
    # The session and sign-out stay reachable, so the person can see why and leave.
    assert client.get("/api/v1/session/").status_code == 200


def test_an_allowed_answer_is_asked_again_after_revalidate_after(provider):
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    assert client.get(DATA).status_code == 200  # still inside Workeasy360's window
    _age_answer(901)
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_ENDED


def test_a_denial_is_asked_again_soon_so_a_renewal_takes_effect(provider):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    assert client.get(DATA).status_code == 403
    provider.entitlement = {"decision": "allow", "reason": "entitled", "write_allowed": True}
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    assert client.get(DATA).status_code == 200


def test_the_provider_cadence_is_honoured_but_bounded(provider):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "allow", "reason": "entitled", "write_allowed": True, "revalidate_after": 86400}
    assert client.get(DATA).status_code == 200
    record = cache.get(entitlement._key(W360_ORG, SUBJECT))
    assert record["fresh_for"] == entitlement.DEFAULT_REVALIDATE_SECONDS


def test_read_only_refuses_writes_but_keeps_reads(provider):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "allow", "reason": "entitled", "write_allowed": False}
    assert client.get(DATA).status_code == 200
    resp = client.patch("/api/v1/organizations/current/", {"name": "Renamed"}, format="json")
    assert resp.status_code == 403 and _type(resp) == entitlement.READ_ONLY


def test_a_platform_failure_with_no_answer_yet_is_not_a_denial(provider):
    client = _signed_in(provider)
    provider.entitlement_status = 503
    assert client.get(DATA).status_code == 200


def test_during_an_outage_the_last_answer_stands_and_the_provider_is_not_hammered(provider):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    assert client.get(DATA).status_code == 403
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    provider.entitlement_status = 503
    asked = len(provider.entitlement_calls())
    assert client.get(DATA).status_code == 403  # an outage never turns a denial into access...
    assert client.get(DATA).status_code == 403
    assert len(provider.entitlement_calls()) == asked + 1  # ...and backs off after one failed attempt


def test_a_provider_that_does_not_offer_the_api_does_not_lock_anyone_out(provider):
    provider.advertise_entitlement = False
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    assert provider.entitlement_calls() == []


def test_a_keel_only_organization_is_never_checked(provider, org_a, client_for):
    client = client_for(org_a.owner, org_a.owner_membership)
    assert client.get(DATA).status_code == 200
    assert provider.entitlement_calls() == []


def test_only_one_request_asks_at_a_time(provider):
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    _age_answer(901)
    key = entitlement._key(W360_ORG, SUBJECT)
    cache.add(f"{key}:refreshing", 1, entitlement.REFRESH_LOCK_SECONDS)  # another request is asking
    asked = len(provider.entitlement_calls())
    assert client.get(DATA).status_code == 200  # the last answer is used meanwhile
    assert len(provider.entitlement_calls()) == asked


def test_a_new_answer_replaces_the_last_one(provider):
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    _age_answer(901)
    started = time.time()
    assert client.get(DATA).status_code == 403
    record = cache.get(entitlement._key(W360_ORG, SUBJECT))
    assert record["decision"] == "deny" and record["reason"] == "expired" and record["checked_at"] >= started


def test_a_refused_client_is_not_an_outage_and_refuses_access(provider):
    """401/403 from Workeasy360: a revoked credential or a suspended integration. Serving on would let every
    expired organization in for as long as nobody noticed."""
    client = _signed_in(provider)
    provider.entitlement_status = 401
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_UNVERIFIED
    provider.entitlement_status = 200  # fixed: back within the denial recheck
    _expire_client_refusal()
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    assert client.get(DATA).status_code == 200


def test_a_known_denial_survives_losing_the_shared_cache(provider):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    assert client.get(DATA).status_code == 403
    cache.clear()  # an eviction, a flush, a Redis restart
    provider.entitlement_status = 503
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_ENDED


def test_a_cache_outage_never_turns_a_denial_into_access(provider, monkeypatch):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    assert client.get(DATA).status_code == 403
    # Redis down with CACHE_FAIL_OPEN: every read answers nothing and add() answers None.
    monkeypatch.setattr(entitlement.cache, "get", lambda *a, **k: None)
    monkeypatch.setattr(entitlement.cache, "add", lambda *a, **k: None)
    assert client.get(DATA).status_code == 403


def test_a_first_check_is_not_waved_through_while_another_request_asks(provider):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    key = entitlement._key(W360_ORG, SUBJECT)
    cache.add(f"{key}:refreshing", 1, entitlement.REFRESH_LOCK_SECONDS)  # another request is asking
    assert client.get(DATA).status_code == 403


def test_an_unexpected_failure_is_an_outage_not_an_error(provider, monkeypatch):
    client = _signed_in(provider)

    def broken(*_args, **_kwargs):
        raise ValueError("unreadable key")

    monkeypatch.setattr(config.get_client(), "verify_entitlement", broken)
    assert client.get(DATA).status_code == 200


def test_a_read_only_organization_can_still_export(provider):
    client = _signed_in(provider)
    provider.entitlement = {"decision": "allow", "reason": "entitled", "write_allowed": False}
    resp = client.post("/api/v1/exports/contacts/", {}, format="json")
    assert resp.status_code != 403, resp.content


# --- per person (completion design section 4): the question names the person signed in -------------------

PERSON_ENDED = "Your access to WorkEasy CRM in this organization has ended. Ask an administrator in Workeasy360."


def _sign_in_as(provider, subject: str, email: str) -> APIClient:
    client = APIClient()
    resp = client.get(START)
    code, state = provider.authorize(resp["Location"], sub=subject, email=email)
    assert client.get(CALLBACK, {"code": code, "state": state}).status_code == 302
    return client


@pytest.mark.parametrize("reason", ["membership_inactive", "no_seat"])
def test_a_removed_member_or_seat_ends_that_persons_access_only(provider, reason):
    client = _signed_in(provider)
    other = _sign_in_as(provider, "w360-user-2", "grace@example.com")
    assert client.get(DATA).status_code == 200
    assert other.get(DATA).status_code == 200
    provider.entitlement_by_subject[SUBJECT] = {"decision": "deny", "reason": reason, "write_allowed": False}
    _age_answer(901)
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_ENDED
    assert resp.json()["detail"] == PERSON_ENDED
    assert other.get(DATA).status_code == 200  # the organization, and the colleague, are fine
    assert client.get("/api/v1/session/").status_code == 200  # the person can still see why and sign out


def test_per_person_answers_do_not_collide(provider):
    client = _signed_in(provider)
    other = _sign_in_as(provider, "w360-user-2", "grace@example.com")
    provider.entitlement_by_subject["w360-user-2"] = {"decision": "deny", "reason": "no_seat", "write_allowed": False}
    assert client.get(DATA).status_code == 200
    assert other.get(DATA).status_code == 403
    keys = {entitlement._key(W360_ORG), entitlement._key(W360_ORG, SUBJECT), entitlement._key(W360_ORG, "w360-user-2")}
    assert len(keys) == 3
    assert cache.get(entitlement._key(W360_ORG, SUBJECT))["decision"] == "allow"
    assert cache.get(entitlement._key(W360_ORG, "w360-user-2"))["reason"] == "no_seat"
    assert cache.get(entitlement._key(W360_ORG)) is None  # nobody asked about the organization alone
    asked = [call.get("subject") for call in provider.entitlement_calls()]
    assert sorted(asked) == [SUBJECT, "w360-user-2"]


def test_a_person_denial_is_asked_again_soon_so_a_restored_seat_takes_effect(provider):
    client = _signed_in(provider)
    provider.entitlement_by_subject[SUBJECT] = {"decision": "deny", "reason": "no_seat", "write_allowed": False}
    assert client.get(DATA).status_code == 403
    assert client.get(DATA).status_code == 403
    assert len(provider.entitlement_calls()) == 1  # not asked on every request
    provider.entitlement_by_subject.clear()
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    assert client.get(DATA).status_code == 200


def test_an_outage_keeps_the_last_per_person_answer(provider):
    client = _signed_in(provider)
    provider.entitlement_by_subject[SUBJECT] = {
        "decision": "deny",
        "reason": "membership_inactive",
        "write_allowed": False,
    }
    assert client.get(DATA).status_code == 403
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    provider.entitlement_status = 503
    resp = client.get(DATA)
    assert resp.status_code == 403 and resp.json()["detail"] == PERSON_ENDED  # an outage never grants access
    provider.entitlement_by_subject.clear()
    other = _sign_in_as(provider, "w360-user-3", "edsger@example.com")
    assert other.get(DATA).status_code == 200  # ...and with no answer for a person yet, it does not deny


def test_a_refusal_fails_a_person_closed(provider):
    client = _signed_in(provider)
    provider.entitlement_status = 401
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_UNVERIFIED
    provider.entitlement_status = 200
    _expire_client_refusal()
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    assert client.get(DATA).status_code == 200


def test_the_subject_comes_from_the_session_without_a_query_per_request(provider, django_assert_max_num_queries):
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    assert client.session["workeasy360_sub"] == SUBJECT
    from apps.accounts.models import ExternalIdentity

    with django_assert_max_num_queries(40) as ctx:
        assert client.get(DATA).status_code == 200
    assert not [q for q in ctx.captured_queries if ExternalIdentity._meta.db_table in q["sql"]]


def test_a_session_without_the_subject_looks_it_up_once_and_remembers_it(provider):
    client = _signed_in(provider)
    session = client.session
    del session["workeasy360_sub"]  # a session from before the subject was kept
    session.save()
    assert client.get(DATA).status_code == 200
    assert provider.entitlement_calls()[-1]["subject"] == SUBJECT
    assert client.session["workeasy360_sub"] == SUBJECT


def test_a_keel_only_account_in_a_linked_organization_is_asked_about_at_organization_level(provider, org_a, client_for):
    with system_context("test.link_organization"):
        Organization.objects.filter(pk=org_a.org.pk).update(workeasy360_organization_id=W360_ORG)
    client = client_for(org_a.owner, org_a.owner_membership)
    assert client.get(DATA).status_code == 200
    calls = provider.entitlement_calls()
    assert len(calls) == 1 and calls[0]["organization_id"] == W360_ORG and "subject" not in calls[0]
    assert client.session["workeasy360_sub"] == ""  # looked up once; nothing to remember but "none"
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    _age_answer_for(entitlement._key(W360_ORG), 901)
    resp = client.get(DATA)
    assert resp.status_code == 403 and resp.json()["detail"].startswith("Your organization's access")


def _age_answer_for(key: str, seconds: int) -> None:
    record = cache.get(key)
    record["checked_at"] -= seconds
    cache.set(key, record, entitlement.LAST_KNOWN_KEEP_SECONDS)


def test_a_celery_soft_time_limit_propagates_out_of_a_request_check(provider, monkeypatch):
    from celery.exceptions import SoftTimeLimitExceeded

    _signed_in(provider)

    def out_of_time(*_args, **_kwargs):
        raise SoftTimeLimitExceeded

    monkeypatch.setattr(config.get_client(), "verify_entitlement", out_of_time)
    with pytest.raises(SoftTimeLimitExceeded):
        entitlement.check(W360_ORG, organization_id="o", subject=SUBJECT)
    assert cache.get(f"{entitlement._key(W360_ORG, SUBJECT)}:backoff") is None  # not an outage
    assert cache.get(f"{entitlement._key(W360_ORG, SUBJECT)}:refreshing") is None


def test_the_entitlement_call_has_a_shorter_timeout_than_sign_in(provider, monkeypatch):
    from apps.accounts.workeasy360 import oidc

    seen: list[float] = []

    class FakeHttpxClient:
        def __init__(self, *, timeout, follow_redirects):
            seen.append(timeout)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def request(self, *args, **kwargs):
            class Response:
                status_code = 200
                content = b"{}"

                def json(self):
                    return {}

            return Response()

    monkeypatch.setattr(oidc.httpx, "Client", FakeHttpxClient)
    monkeypatch.setattr(config, "transport_override", None)
    client = config.get_client()
    assert client.entitlement_transport is not None
    client.entitlement_transport("POST", "https://id.example/verify", {})
    client.transport("POST", "https://id.example/token", {})
    assert seen == [oidc.ENTITLEMENT_TIMEOUT_SECONDS, oidc.HTTP_TIMEOUT_SECONDS]
    assert oidc.ENTITLEMENT_TIMEOUT_SECONDS < oidc.HTTP_TIMEOUT_SECONDS


# --- SSO-only: a person with no Workeasy360 identity cannot be asked about, so is not served ----------------


def _link_org(bundle) -> None:
    with system_context("test.link_organization"):
        Organization.objects.filter(pk=bundle.org.pk).update(workeasy360_organization_id=W360_ORG)


def test_sso_only_refuses_an_unfederated_account_in_a_linked_organization(provider, settings, org_a, client_for):
    settings.WORKEASY360_SSO_ONLY = True
    _link_org(org_a)
    client = client_for(org_a.owner, org_a.owner_membership)  # a session that never came from Workeasy360
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.SIGN_IN_REQUIRED
    assert provider.entitlement_calls() == []  # not served on the organization's answer
    # The session endpoint (and with it sign-out) stays reachable, so the screen can render.
    assert client.get("/api/v1/session/").status_code == 200


def test_sso_only_asks_about_the_person_when_the_account_is_federated(provider, settings):
    settings.WORKEASY360_SSO_ONLY = True
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    assert provider.entitlement_calls()[-1]["subject"] == SUBJECT
    provider.entitlement_by_subject[SUBJECT] = {
        "decision": "deny",
        "reason": "membership_inactive",
        "write_allowed": False,
    }
    _age_answer(901)
    assert _type(client.get(DATA)) == entitlement.ACCESS_ENDED


def test_a_session_opened_before_sso_only_was_switched_on_is_sent_to_sign_in(provider, settings, org_a, client_for):
    """A password session of an account with no Workeasy360 identity survives the switch; it must not."""
    _link_org(org_a)
    client = client_for(org_a.owner, org_a.owner_membership)
    assert client.get(DATA).status_code == 200  # SSO-only off: the organization's answer, as ever
    settings.WORKEASY360_SSO_ONLY = True
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.SIGN_IN_REQUIRED


def test_without_sso_only_an_unfederated_account_is_asked_about_at_organization_level(
    provider, settings, org_a, client_for
):
    settings.WORKEASY360_SSO_ONLY = False
    _link_org(org_a)
    client = client_for(org_a.owner, org_a.owner_membership)
    assert client.get(DATA).status_code == 200
    (call,) = provider.entitlement_calls()
    assert call["organization_id"] == W360_ORG and "subject" not in call


def test_sso_only_leaves_an_unlinked_organization_alone(provider, settings, org_a, client_for):
    settings.WORKEASY360_SSO_ONLY = True
    client = client_for(org_a.owner, org_a.owner_membership)
    assert client.get(DATA).status_code == 200
    assert provider.entitlement_calls() == []


def test_an_api_credential_is_asked_about_at_organization_level_even_in_sso_only(
    provider, settings, org_a, owner_client, reauthenticate
):
    reauthenticate(owner_client)
    created = owner_client.post(
        "/api/v1/integrations/api-credentials/", {"name": "Sync", "scopes": ["contacts:read"]}, format="json"
    )
    assert created.status_code == 201, created.content
    settings.WORKEASY360_SSO_ONLY = True
    _link_org(org_a)
    machine = APIClient()
    machine.credentials(HTTP_AUTHORIZATION=f"Bearer {created.json()['key']}")
    resp = machine.get("/api/v1/contacts/")
    assert resp.status_code == 200, resp.content
    (call,) = provider.entitlement_calls()
    assert call["organization_id"] == W360_ORG and "subject" not in call
    provider.entitlement = {"decision": "deny", "reason": "expired", "write_allowed": False}
    _age_answer_for(entitlement._key(W360_ORG), 901)
    resp = machine.get("/api/v1/contacts/")
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_ENDED


# --- a refusal of the product's own client is client-wide ---------------------------------------------------


def _expire_client_refusal() -> None:
    cache.delete(entitlement._CLIENT_REFUSED_KEY)
    entitlement._local_refused_until = 0.0


def test_a_refusal_closes_every_question_without_asking(provider):
    first = _signed_in(provider)
    second = _sign_in_as(provider, "w360-user-2", "grace@example.com")
    assert second.get(DATA).status_code == 200  # a fresh allow is cached for this person
    provider.entitlement_status = 401
    resp = first.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_UNVERIFIED
    asked = len(provider.entitlement_calls())
    # Not just that key: the other person, with a fresh allow, is refused too - and nobody asks again.
    resp = second.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_UNVERIFIED
    assert first.get(DATA).status_code == 403
    assert len(provider.entitlement_calls()) == asked


def test_the_refusal_covers_organization_level_questions_too(provider, org_a, client_for):
    with system_context("test.link_organization"):
        Organization.objects.filter(pk=org_a.org.pk).update(workeasy360_organization_id=W360_ORG)
    client = _signed_in(provider)
    provider.entitlement_status = 401
    assert client.get(DATA).status_code == 403
    asked = len(provider.entitlement_calls())
    keel_only = client_for(org_a.owner, org_a.owner_membership)
    resp = keel_only.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_UNVERIFIED
    assert len(provider.entitlement_calls()) == asked


def test_the_refusal_survives_losing_the_shared_cache(provider):
    client = _signed_in(provider)
    provider.entitlement_status = 401
    assert client.get(DATA).status_code == 403
    asked = len(provider.entitlement_calls())
    cache.clear()  # an eviction, a flush, a Redis restart
    provider.entitlement_status = 200
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_UNVERIFIED
    assert len(provider.entitlement_calls()) == asked


def test_after_the_window_one_question_is_asked_again(provider):
    client = _signed_in(provider)
    provider.entitlement_status = 401
    assert client.get(DATA).status_code == 403
    provider.entitlement_status = 200  # the credential is fixed
    _expire_client_refusal()
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    asked = len(provider.entitlement_calls())
    assert client.get(DATA).status_code == 200
    assert client.get(DATA).status_code == 200
    assert len(provider.entitlement_calls()) == asked + 1


def test_a_still_revoked_client_is_refused_again_after_the_window(provider):
    client = _signed_in(provider)
    provider.entitlement_status = 401
    assert client.get(DATA).status_code == 403
    _expire_client_refusal()
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    assert client.get(DATA).status_code == 403  # asked once, refused, closed for another window
    assert time.time() < entitlement._local_refused_until


def test_a_429_without_a_recent_refusal_is_an_outage(provider):
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    provider.entitlement_status = 429
    _age_answer(901)
    assert client.get(DATA).status_code == 200  # the last answer stands, as for any outage


def test_a_429_arriving_inside_the_refusal_window_counts_as_a_refusal(provider, monkeypatch):
    """Workeasy360 limits failed client authentications: a question already in flight when the refusal landed
    is answered 429. Read as an outage it would let that person through."""
    from apps.accounts.workeasy360.oidc import SSOError

    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    _age_answer(901)  # the person's allow is stale, so the next request asks

    def raced(*_args, **_kwargs):
        entitlement._refuse_client(time.time())  # another request's question was refused meanwhile
        raise SSOError("provider_rate_limited", "entitlement endpoint 429")

    monkeypatch.setattr(config.get_client(), "verify_entitlement", raced)
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_UNVERIFIED


def test_a_429_after_the_window_but_within_five_minutes_of_a_refusal_is_still_a_refusal(provider):
    """The one question asked after the 60 s mark can still meet Workeasy360's failed-authentication limiter.
    Read as an outage it would hand everyone their last answers back while the credential is revoked."""
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    provider.entitlement_status = 401
    _age_answer(901)
    assert client.get(DATA).status_code == 403
    _expire_client_refusal()  # the 60 s mark has lapsed; the refusal itself was moments ago
    provider.entitlement_status = 429
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    resp = client.get(DATA)
    assert resp.status_code == 403 and _type(resp) == entitlement.ACCESS_UNVERIFIED
    assert time.time() < entitlement._local_refused_until  # and the client is closed for another window


def test_a_429_long_after_the_last_refusal_is_an_outage(provider):
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    provider.entitlement_status = 401
    _age_answer(901)
    assert client.get(DATA).status_code == 403
    _expire_client_refusal()
    # Backdate the refusal past the five minutes (shared cache and this process's copy).
    entitlement._local_last_refusal -= entitlement.RATE_LIMIT_AFTER_REFUSAL_SECONDS + 1
    cache.delete(entitlement._LAST_REFUSAL_KEY)
    provider.entitlement_status = 429
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    client.get(DATA)
    assert entitlement._local_refused_until <= time.time()  # a 429 this long after is an outage: no new mark
    # ...so a person with no answer standing is not refused on its account.
    other = _sign_in_as(provider, "w360-user-2", "grace@example.com")
    assert other.get(DATA).status_code == 200


def test_a_429_does_not_move_the_anchor_it_is_measured_from(provider):
    client = _signed_in(provider)
    assert client.get(DATA).status_code == 200
    provider.entitlement_status = 401
    _age_answer(901)
    assert client.get(DATA).status_code == 403
    anchor = entitlement._local_last_refusal
    _expire_client_refusal()
    provider.entitlement_status = 429
    _age_answer(entitlement.DENIAL_RECHECK_SECONDS + 1)
    assert client.get(DATA).status_code == 403
    assert entitlement._local_last_refusal == anchor  # only a real refusal moves it
