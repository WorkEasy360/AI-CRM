"""The OpenID Connect protocol of "Sign in with Workeasy360", through Keel's views and the workeasy360-sso
connector: discovery, PKCE, the seven ID token checks, key rotation, the client assertion.

These replace the tests of Keel's former hand-written client (apps/accounts/workeasy360/oidc.py): the same
behaviours, asserted where a person meets them - the callback signs in, or answers ``/login?sso_error=``."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from base64 import urlsafe_b64encode
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from rest_framework.test import APIClient
from workeasy360_sso.models import PendingSignIn

from apps.accounts.models import User
from tests.accounts import workeasy360_fake as fake

pytestmark = [pytest.mark.django_db, pytest.mark.security]

START = "/api/auth/workeasy360/start"
CALLBACK = "/api/auth/callback/workeasy360"


@pytest.fixture
def provider(settings):
    return fake.configure(settings, fake.FakeProvider())


def _query(location: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(location).query).items()}


def _error_of(resp) -> str | None:
    assert resp.status_code == 302
    if not resp["Location"].startswith("/login?"):
        return None
    return _query(resp["Location"])["sso_error"]


def _sign_in(client, provider, **claims):
    resp = client.get(START)
    assert resp.status_code == 302, resp.content
    code, state = provider.authorize(resp["Location"], **claims)
    return client.get(CALLBACK, {"code": code, "state": state})


def _signed_in(resp) -> bool:
    return _error_of(resp) is None


def test_the_code_challenge_is_s256_of_a_verifier_kept_server_side(provider):
    client = APIClient()
    location = client.get(START)["Location"]
    query = _query(location)
    flow = PendingSignIn.objects.get()
    assert 43 <= len(flow.code_verifier) <= 128 and flow.code_verifier not in location
    digest = hashlib.sha256(flow.code_verifier.encode()).digest()
    assert query["code_challenge"] == urlsafe_b64encode(digest).rstrip(b"=").decode()
    assert query["code_challenge_method"] == "S256"


def test_the_authorization_request_carries_every_parameter_and_the_organization(provider):
    client = APIClient()
    org = "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c"
    location = client.get(START, {"organization": org})["Location"]
    query = _query(location)
    assert location.startswith(fake.AUTHORIZE + "?")
    assert query["scope"] == "openid email profile organization"
    assert query["client_id"] == fake.CLIENT_ID and query["redirect_uri"] == fake.REDIRECT_URI
    assert len(query["state"]) >= 43 and len(query["nonce"]) >= 43
    assert query["organization"] == org
    assert "organization" not in _query(APIClient().get(START)["Location"])
    assert "prompt" not in query


def test_the_full_exchange_signs_in_with_the_verified_claims(provider):
    client = APIClient()
    assert _signed_in(_sign_in(client, provider, aal=2))
    assert client.session["workeasy360_aal"] == 2 and client.session["workeasy360_sub"] == "w360-user-1"


def test_discovery_naming_another_issuer_is_refused(provider):
    provider.discovery_issuer = "https://evil.example"
    assert _error_of(APIClient().get(START)) == "unavailable"


def test_an_unknown_state_stops_before_the_token_endpoint(provider):
    client = APIClient()
    code, _state = provider.authorize(client.get(START)["Location"])
    assert _error_of(client.get(CALLBACK, {"code": code, "state": "forged"})) == "expired"
    assert provider.token_calls() == []
    assert "_auth_user_id" not in client.session


def test_a_nonce_from_another_session_is_refused(provider):
    client = APIClient()
    code, state = provider.authorize(client.get(START)["Location"])
    issued = {}

    def other_nonce(form):
        issued["token"] = provider.id_token(nonce="another-session")
        return 200, {"id_token": issued["token"], "token_type": "Bearer", "access_token": "at"}

    provider.token_override = other_nonce
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "refused"
    assert "_auth_user_id" not in client.session


@pytest.mark.parametrize(
    "overrides",
    [
        {"aud": "another-product"},
        {"iss": "https://evil.example"},
        {"exp": int(time.time()) - 120, "iat": int(time.time()) - 600},
        {"typ": "access_token"},
        {"organization_id": None},
        {"jti": None},
    ],
)
def test_the_id_token_checks(provider, overrides):
    client = APIClient()
    assert _error_of(_sign_in(client, provider, **overrides)) == "refused"
    assert "_auth_user_id" not in client.session
    assert not User.objects.filter(email="ada@example.com").exists()


@pytest.mark.parametrize(
    "overrides",
    [
        {"azp": "another-client"},
        {"azp": ""},
        {"azp": ["keel-test-client"]},
        {"aud": [fake.CLIENT_ID, "another-client"]},
        {"aud": [fake.CLIENT_ID, "another-client"], "azp": "another-client"},
        {"aud": ["another-client", fake.CLIENT_ID]},
        {"aud": [fake.CLIENT_ID, fake.CLIENT_ID]},
    ],
)
def test_a_token_issued_to_another_client_is_refused(provider, overrides):
    """aud must be exactly this client, or (several audiences) azp must be this client; azp, if present, is us."""
    assert _error_of(_sign_in(APIClient(), provider, **overrides)) == "refused"


@pytest.mark.parametrize(
    "overrides",
    [
        {},
        {"azp": fake.CLIENT_ID},
        {"aud": [fake.CLIENT_ID]},
        {"aud": [fake.CLIENT_ID], "azp": fake.CLIENT_ID},
        {"aud": [fake.CLIENT_ID, "another-client"], "azp": fake.CLIENT_ID},
    ],
)
def test_a_token_issued_to_this_client_is_accepted(provider, overrides):
    assert _signed_in(_sign_in(APIClient(), provider, **overrides))


def test_expiry_within_leeway_is_accepted(provider):
    now = int(time.time())
    assert _signed_in(_sign_in(APIClient(), provider, exp=now - 10, iat=now - 300))


def test_the_algorithm_comes_from_the_key_set_not_the_header(provider):
    """An HS256 token "signed" with the provider's public key (algorithm confusion) is refused."""
    client = APIClient()
    location = client.get(START)["Location"]
    code, state = provider.authorize(location)
    public_pem = provider.signing_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM, format=serialization.PublicFormat.SubjectPublicKeyInfo
    )
    now = int(time.time())
    claims = {
        "iss": fake.ISSUER,
        "sub": "attacker",
        "aud": fake.CLIENT_ID,
        "iat": now,
        "exp": now + 300,
        "jti": "x",
        "typ": "id_token",
        "nonce": _query(location)["nonce"],
        "organization_id": "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c",
        "product_code": "easy_crm",
        "email": "attacker@example.com",
        "email_verified": True,
    }
    header = {"alg": "HS256", "kid": provider.kid, "typ": "JWT"}

    def b64(data: bytes) -> str:
        return urlsafe_b64encode(data).rstrip(b"=").decode()

    signing_input = f"{b64(json.dumps(header).encode())}.{b64(json.dumps(claims).encode())}"
    signature = hmac.new(public_pem, signing_input.encode(), hashlib.sha256).digest()
    forged = f"{signing_input}.{b64(signature)}"
    provider.token_override = lambda form: (200, {"id_token": forged, "token_type": "Bearer", "access_token": "at"})
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "refused"
    assert not User.objects.filter(email="attacker@example.com").exists()


def test_a_key_set_entry_with_an_unsupported_alg_is_refused(provider):
    provider.keys = [{**provider.keys[0], "alg": "HS256"}]
    assert _error_of(_sign_in(APIClient(), provider)) == "refused"


def test_an_unknown_kid_refreshes_the_key_set_once_then_fails(provider):
    assert _signed_in(_sign_in(APIClient(), provider))  # warms the caches
    provider.calls.clear()
    stranger = fake.rsa_key("stranger")
    assert _error_of(_sign_in(APIClient(), provider, kid="unknown", key=stranger)) == "refused"
    assert [url for _m, url, _f in provider.calls].count(fake.JWKS) == 1


def test_a_rotated_key_is_found_after_one_refresh(provider):
    assert _signed_in(_sign_in(APIClient(), provider))
    rotated = fake.rsa_key("rotated")
    provider.keys.append(fake.public_jwk(rotated, "provider-key-2"))
    assert _signed_in(_sign_in(APIClient(), provider, kid="provider-key-2", key=rotated))


def test_a_token_signed_by_another_key_under_a_known_kid_is_refused(provider):
    assert _error_of(_sign_in(APIClient(), provider, key=fake.rsa_key("stranger"))) == "refused"


def test_the_client_assertion_names_this_client_and_the_token_endpoint(provider):
    _sign_in(APIClient(), provider)
    _sign_in(APIClient(), provider)
    first, second = (form["client_assertion"] for form in provider.token_calls())
    header = jwt.get_unverified_header(first)
    assert header["kid"] == fake.CLIENT_KID and header["alg"] == "RS256"
    claims = jwt.decode(first, provider.client_key.public_key(), algorithms=["RS256"], audience=fake.TOKEN)
    assert claims["iss"] == claims["sub"] == fake.CLIENT_ID
    assert claims["aud"] == fake.TOKEN
    assert claims["exp"] - claims["iat"] <= 60
    assert jwt.decode(second, options={"verify_signature": False})["jti"] != claims["jti"]
    assert (
        provider.token_calls()[0]["client_assertion_type"] == "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
    )


def test_a_reused_code_is_a_routine_refusal(provider):
    client = APIClient()
    code, state = provider.authorize(client.get(START)["Location"])
    assert _signed_in(client.get(CALLBACK, {"code": code, "state": state}))
    other = APIClient()
    location = other.get(START)["Location"]
    _unused, other_state = provider.authorize(location)
    # The code is single-use at Workeasy360 (invalid_grant): "try again".
    assert _error_of(other.get(CALLBACK, {"code": code, "state": other_state})) == "refused"


def test_a_provider_outage_is_unavailable_not_refused(provider):
    client = APIClient()
    code, state = provider.authorize(client.get(START)["Location"])
    provider.token_status, provider.token_error = 503, "temporarily_unavailable"
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "unavailable"


def test_a_wrong_pkce_verifier_is_refused_by_the_provider(provider):
    client = APIClient()
    code, state = provider.authorize(client.get(START)["Location"])
    PendingSignIn.objects.update(code_verifier="x" * 43)
    assert _error_of(client.get(CALLBACK, {"code": code, "state": state})) == "refused"
