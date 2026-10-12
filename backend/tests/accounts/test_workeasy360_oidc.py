"""The Workeasy360 OIDC client on its own: discovery, the seven ID token checks, the client assertion."""

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

from apps.accounts.workeasy360.oidc import SSOError, Workeasy360Client, pkce_pair
from tests.accounts import workeasy360_fake as fake

pytestmark = pytest.mark.security


@pytest.fixture
def provider():
    return fake.FakeProvider()


def _client(provider, **kwargs) -> Workeasy360Client:
    return Workeasy360Client(
        issuer=fake.ISSUER,
        client_id=fake.CLIENT_ID,
        redirect_uri=fake.REDIRECT_URI,
        private_key_pem=provider.client_private_pem,
        key_id=fake.CLIENT_KID,
        transport=provider.transport,
        **kwargs,
    )


def _code(provider, client, **claims):
    auth = client.authorization_request()
    code, state = provider.authorize(auth.url, **claims)
    return auth, code, state


def test_pkce_pair_is_s256():
    verifier, challenge = pkce_pair()
    assert 43 <= len(verifier) <= 128
    assert challenge == urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def test_authorization_request_carries_every_parameter_and_the_organization(provider):
    auth = _client(provider).authorization_request(organization_id="7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c")
    query = {k: v[0] for k, v in parse_qs(urlsplit(auth.url).query).items()}
    assert auth.url.startswith(fake.AUTHORIZE + "?")
    assert query["scope"] == "openid email profile organization"
    assert query["state"] == auth.state and query["nonce"] == auth.nonce
    assert query["code_challenge_method"] == "S256"
    assert query["organization"] == "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c"
    assert "organization" not in parse_qs(urlsplit(_client(provider).authorization_request().url).query)


def test_a_fresh_sign_in_is_requested_with_prompt_login(provider):
    auth = _client(provider).authorization_request(prompt="login")
    assert parse_qs(urlsplit(auth.url).query)["prompt"] == ["login"]


def test_the_end_session_url_names_only_the_client_and_the_registered_uri(provider):
    url = _client(provider).end_session_url(post_logout_redirect_uri="https://crm.example.com/login")
    assert url.startswith(fake.END_SESSION + "?")
    assert parse_qs(urlsplit(url).query) == {
        "client_id": [fake.CLIENT_ID],
        "post_logout_redirect_uri": ["https://crm.example.com/login"],
    }
    provider.advertise_end_session = False
    assert _client(provider).end_session_url(post_logout_redirect_uri="https://crm.example.com/login") == ""


def test_full_exchange_returns_verified_claims(provider):
    client = _client(provider)
    auth, code, state = _code(provider, client, aal=2)
    claims = client.complete(
        code=code, returned_state=state, expected_state=auth.state, nonce=auth.nonce, code_verifier=auth.code_verifier
    )
    assert claims["sub"] == "w360-user-1" and claims["aal"] == 2


def test_discovery_naming_another_issuer_is_refused(provider):
    provider.discovery_issuer = "https://evil.example"
    with pytest.raises(SSOError) as exc:
        _client(provider).authorization_request()
    assert exc.value.code == "provider_misconfigured"


def test_state_mismatch_stops_before_the_token_endpoint(provider):
    client = _client(provider)
    auth, code, _state = _code(provider, client)
    with pytest.raises(SSOError) as exc:
        client.complete(
            code=code,
            returned_state="forged",
            expected_state=auth.state,
            nonce=auth.nonce,
            code_verifier=auth.code_verifier,
        )
    assert exc.value.code == "state_mismatch"
    assert not any(url == fake.TOKEN for _m, url, _f in provider.calls)


def test_nonce_mismatch_is_refused(provider):
    client = _client(provider)
    auth, code, state = _code(provider, client)
    with pytest.raises(SSOError) as exc:
        client.complete(
            code=code,
            returned_state=state,
            expected_state=auth.state,
            nonce="another-session",
            code_verifier=auth.code_verifier,
        )
    assert exc.value.code == "invalid_token" and "nonce" in exc.value.detail


@pytest.mark.parametrize(
    ("overrides", "fragment"),
    [
        ({"aud": "another-product"}, "audience"),
        ({"iss": "https://evil.example"}, "issuer"),
        ({"exp": int(time.time()) - 120, "iat": int(time.time()) - 600}, "expired"),
        ({"typ": "access_token"}, "typ"),
        ({"organization_id": None}, "organization_id"),
        ({"jti": None}, "jti"),
    ],
)
def test_id_token_checks(provider, overrides, fragment):
    client = _client(provider)
    token = provider.id_token(nonce="n", **overrides)
    with pytest.raises(SSOError) as exc:
        client.verify_id_token(token, nonce="n")
    assert exc.value.code == "invalid_token"
    assert fragment in exc.value.detail.lower()


def test_expiry_within_leeway_is_accepted(provider):
    now = int(time.time())
    token = provider.id_token(nonce="n", exp=now - 10, iat=now - 300)
    assert _client(provider).verify_id_token(token, nonce="n")["sub"] == "w360-user-1"


def test_algorithm_comes_from_the_key_set_not_the_header(provider):
    """An HS256 token "signed" with the provider's public key (algorithm confusion) is refused."""
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
        "nonce": "n",
        "organization_id": "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c",
    }
    header = {"alg": "HS256", "kid": provider.kid, "typ": "JWT"}

    def b64(data: bytes) -> str:
        return urlsafe_b64encode(data).rstrip(b"=").decode()

    signing_input = f"{b64(json.dumps(header).encode())}.{b64(json.dumps(claims).encode())}"
    signature = hmac.new(public_pem, signing_input.encode(), hashlib.sha256).digest()
    forged = f"{signing_input}.{b64(signature)}"
    with pytest.raises(SSOError) as exc:
        _client(provider).verify_id_token(forged, nonce="n")
    assert exc.value.code == "invalid_token"


def test_a_key_set_entry_with_an_unsupported_alg_is_refused(provider):
    provider.keys = [{**provider.keys[0], "alg": "HS256"}]
    with pytest.raises(SSOError) as exc:
        _client(provider).verify_id_token(provider.id_token(nonce="n"), nonce="n")
    assert "unsupported alg" in exc.value.detail


def test_unknown_kid_refreshes_the_key_set_once_then_fails(provider):
    client = _client(provider)
    client.verify_id_token(provider.id_token(nonce="n"), nonce="n")  # warms the caches
    provider.calls.clear()
    stranger = fake.rsa_key("stranger")
    with pytest.raises(SSOError) as exc:
        client.verify_id_token(provider.id_token(nonce="n", kid="unknown", key=stranger), nonce="n")
    assert exc.value.code == "invalid_token"
    assert [url for _m, url, _f in provider.calls].count(fake.JWKS) == 1


def test_rotated_key_is_found_after_one_refresh(provider):
    client = _client(provider)
    client.verify_id_token(provider.id_token(nonce="n"), nonce="n")
    rotated = fake.rsa_key("rotated")
    provider.keys.append(fake.public_jwk(rotated, "provider-key-2"))
    claims = client.verify_id_token(provider.id_token(nonce="n", kid="provider-key-2", key=rotated), nonce="n")
    assert claims["sub"] == "w360-user-1"


def test_a_token_signed_by_another_key_under_a_known_kid_is_refused(provider):
    with pytest.raises(SSOError) as exc:
        _client(provider).verify_id_token(provider.id_token(nonce="n", key=fake.rsa_key("stranger")), nonce="n")
    assert "signature" in exc.value.detail.lower()


def test_client_assertion_claims_and_header(provider):
    now = 1_900_000_000.0
    assertion = _client(provider, clock=lambda: now).client_assertion()
    header = jwt.get_unverified_header(assertion)
    assert header["kid"] == fake.CLIENT_KID and header["alg"] == "RS256"
    claims = jwt.decode(
        assertion,
        provider.client_key.public_key(),
        algorithms=["RS256"],
        audience=fake.TOKEN,
        options={"verify_exp": False, "verify_iat": False},
    )
    assert claims["iss"] == claims["sub"] == fake.CLIENT_ID
    assert claims["aud"] == fake.TOKEN
    assert claims["iat"] == int(now) and claims["exp"] - claims["iat"] <= 60
    second = jwt.decode(_client(provider, clock=lambda: now).client_assertion(), options={"verify_signature": False})
    assert second["jti"] != claims["jti"]


def test_invalid_grant_is_a_routine_refusal(provider):
    client = _client(provider)
    auth, code, state = _code(provider, client)
    kwargs = {
        "returned_state": state,
        "expected_state": auth.state,
        "nonce": auth.nonce,
        "code_verifier": auth.code_verifier,
    }
    client.complete(code=code, **kwargs)
    with pytest.raises(SSOError) as exc:  # the code is single-use
        client.complete(code=code, **kwargs)
    assert exc.value.code == "sign_in_refused" and "invalid_grant" in exc.value.detail


def test_provider_outage_is_unavailable_not_refused(provider):
    client = _client(provider)
    auth, code, state = _code(provider, client)
    provider.token_status, provider.token_error = 503, "temporarily_unavailable"
    with pytest.raises(SSOError) as exc:
        client.complete(
            code=code,
            returned_state=state,
            expected_state=auth.state,
            nonce=auth.nonce,
            code_verifier=auth.code_verifier,
        )
    assert exc.value.code == "provider_unavailable"


def test_wrong_pkce_verifier_is_refused_by_the_provider(provider):
    client = _client(provider)
    auth, code, state = _code(provider, client)
    with pytest.raises(SSOError) as exc:
        client.complete(
            code=code, returned_state=state, expected_state=auth.state, nonce=auth.nonce, code_verifier=pkce_pair()[0]
        )
    assert exc.value.code == "sign_in_refused"
