"""An in-process stand-in for the Workeasy360 OpenID provider, plugged in as the client's transport.

It serves discovery and the key set, records what the browser was sent to authorize, and answers the
token endpoint the way the real one does: client assertion signature, PKCE verifier and redirect URI are
checked, and a code is single-use. The entitlement API answers ``self.entitlement`` (allow, by default), or
``self.entitlement_by_subject[subject]`` when the request names a person, to a correctly authenticated client.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, urlsplit

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

ISSUER = "https://id.workeasy360.test"
CLIENT_ID = "keel-test-client"
CLIENT_KID = "cred-test-1"
REDIRECT_URI = "http://testserver/api/auth/callback/workeasy360"
AUTHORIZE = f"{ISSUER}/oauth/authorize"
TOKEN = f"{ISSUER}/oauth/token"
JWKS = f"{ISSUER}/.well-known/jwks.json"
END_SESSION = f"{ISSUER}/oauth/logout"
ENTITLEMENT = f"{ISSUER}/integrations/entitlements/verify"

_KEYS: dict[str, rsa.RSAPrivateKey] = {}


def rsa_key(name: str) -> rsa.RSAPrivateKey:
    """2048-bit keys are slow to generate; one per name per test session."""
    if name not in _KEYS:
        _KEYS[name] = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return _KEYS[name]


def pem(key: rsa.RSAPrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()


def public_jwk(key: rsa.RSAPrivateKey, kid: str, alg: str = "RS256") -> dict[str, Any]:
    jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update({"kid": kid, "alg": alg, "use": "sig"})
    return jwk


class FakeProvider:
    def __init__(self) -> None:
        self.signing_key = rsa_key("provider")
        self.client_key = rsa_key("client")
        self.kid = "provider-key-1"
        self.discovery_issuer = ISSUER
        self.keys: list[dict[str, Any]] = [public_jwk(self.signing_key, self.kid)]
        self.calls: list[tuple[str, str, dict | None]] = []
        self.token_status = 200
        self.token_error = ""
        self.advertise_end_session = True
        self.advertise_entitlement = True
        self.entitlement_status = 200
        self.entitlement: dict[str, Any] = {
            "decision": "allow",
            "reason": "entitled",
            "write_allowed": True,
            "revalidate_after": 900,
        }
        # Answers for one person (the ``subject`` form field), which win over ``entitlement``. Without a
        # ``subject`` field the answer is the organization's, as the real endpoint's is.
        self.entitlement_by_subject: dict[str, dict[str, Any]] = {}
        # Answers for one organization (the ``organization_id`` form field) when no person-specific one applies.
        self.entitlement_by_organization: dict[str, dict[str, Any]] = {}
        self._codes: dict[str, dict[str, Any]] = {}

    @property
    def client_private_pem(self) -> str:
        return pem(self.client_key)

    # --- what the browser would do at Workeasy360 ---------------------------

    def authorize(self, location: str, **claims: Any) -> tuple[str, str]:
        """Approve the authorization request at ``location``; returns (code, state)."""
        query = {k: v[0] for k, v in parse_qs(urlsplit(location).query).items()}
        assert location.startswith(AUTHORIZE + "?")
        assert query["response_type"] == "code" and query["code_challenge_method"] == "S256"
        assert query["client_id"] == CLIENT_ID and query["redirect_uri"] == REDIRECT_URI
        code = uuid.uuid4().hex
        self._codes[code] = {"query": query, "claims": claims}
        return code, query["state"]

    # --- tokens -------------------------------------------------------------

    def id_token(self, *, nonce: str, kid: str | None = None, key=None, headers=None, **overrides: Any) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": ISSUER,
            "sub": "w360-user-1",
            "aud": CLIENT_ID,
            "iat": now,
            "exp": now + 300,
            "jti": uuid.uuid4().hex,
            "typ": "id_token",
            "nonce": nonce,
            # When the person entered their password at Workeasy360: like the real provider for a
            # password session, "just now" unless a test says otherwise.
            "auth_time": now,
            "organization_id": "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c",
            "product_code": "easy_crm",
            "aal": 1,
            "email": "ada@example.com",
            "email_verified": True,
            "name": "Ada Lovelace",
            "organization_name": "Analytical Engines",
        }
        claims.update(overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        return jwt.encode(
            claims,
            pem(key or self.signing_key),
            algorithm="RS256",
            headers={"kid": kid or self.kid, **(headers or {})},
        )

    # --- the transport ------------------------------------------------------

    def transport(self, method: str, url: str, form: dict[str, str] | None) -> tuple[int, dict[str, Any]]:
        self.calls.append((method, url, form))
        if method == "GET" and url == f"{ISSUER}/.well-known/openid-configuration":
            document = {
                "issuer": self.discovery_issuer,
                "authorization_endpoint": AUTHORIZE,
                "token_endpoint": TOKEN,
                "jwks_uri": JWKS,
            }
            if self.advertise_end_session:
                document["end_session_endpoint"] = END_SESSION
            if self.advertise_entitlement:
                document["workeasy360_entitlement_endpoint"] = ENTITLEMENT
            return 200, document
        if method == "GET" and url == JWKS:
            return 200, {"keys": self.keys}
        if method == "POST" and url == TOKEN:
            return self._token(form or {})
        if method == "POST" and url == ENTITLEMENT:
            return self._entitlement(form or {})
        return 404, {}

    def _authenticate_client(self, form: dict[str, str]) -> None:
        """private_key_jwt, as both endpoints check it: the token endpoint is the audience either way."""
        assertion = jwt.decode(
            form["client_assertion"],
            self.client_key.public_key(),
            algorithms=["RS256"],
            audience=TOKEN,
            issuer=CLIENT_ID,
        )
        assert assertion["sub"] == CLIENT_ID
        assert jwt.get_unverified_header(form["client_assertion"])["kid"] == CLIENT_KID

    def _entitlement(self, form: dict[str, str]) -> tuple[int, dict[str, Any]]:
        self._authenticate_client(form)
        assert "product_code" not in form  # the product is the authenticated client, never a parameter
        if self.entitlement_status != 200:
            return self.entitlement_status, {"error": "temporarily_unavailable"}
        answer = self.entitlement_by_subject.get(form.get("subject", ""))
        if answer is None:
            answer = self.entitlement_by_organization.get(form["organization_id"], self.entitlement)
        return 200, {**answer, "organization_id": form["organization_id"], "product_code": "easy_crm"}

    def entitlement_calls(self) -> list[dict | None]:
        return [form for method, url, form in self.calls if method == "POST" and url == ENTITLEMENT]

    def _token(self, form: dict[str, str]) -> tuple[int, dict[str, Any]]:
        if self.token_status != 200:
            return self.token_status, {"error": self.token_error}
        self._authenticate_client(form)
        grant = self._codes.pop(form.get("code", ""), None)  # single use
        if grant is None or form.get("redirect_uri") != REDIRECT_URI:
            return 400, {"error": "invalid_grant"}
        digest = hashlib.sha256(form["code_verifier"].encode()).digest()
        if base64.urlsafe_b64encode(digest).rstrip(b"=").decode() != grant["query"]["code_challenge"]:
            return 400, {"error": "invalid_grant"}
        token = self.id_token(nonce=grant["query"]["nonce"], **grant["claims"])
        return 200, {"id_token": token, "access_token": "at", "token_type": "Bearer", "expires_in": 300}
