"""CSRF, security headers, error format, throttling and payload limits."""

from __future__ import annotations

import json

import pytest
from rest_framework.test import APIClient

from security.throttles import AnonThrottle

pytestmark = [pytest.mark.django_db, pytest.mark.security]


def test_csrf_required_for_state_changes(org_a, client_for):
    client = client_for(org_a.owner, org_a.owner_membership, enforce_csrf=True)
    resp = client.post("/api/v1/teams/", {"name": "T"}, format="json")
    assert resp.status_code == 403
    assert resp.json()["type"] in {"permission_denied", "not_authenticated"}
    # with the token from the cookie it works
    client.get("/api/v1/session/")
    token = client.cookies.get("keel_csrftoken")
    assert token is not None
    resp = client.post("/api/v1/teams/", {"name": "T"}, format="json", HTTP_X_CSRFTOKEN=token.value)
    assert resp.status_code == 201


def test_security_headers_present(anon_client):
    resp = anon_client.get("/health/")
    assert resp["X-Content-Type-Options"] == "nosniff"
    assert resp["X-Frame-Options"] == "DENY"
    assert resp["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "frame-ancestors 'none'" in resp["Content-Security-Policy"]
    assert "Permissions-Policy" in resp
    assert resp["Cross-Origin-Opener-Policy"] == "same-origin"
    assert resp["X-Request-ID"]
    api = anon_client.get("/api/v1/session/")
    assert api["Cache-Control"] == "no-store"


def test_request_id_is_validated_and_echoed(anon_client):
    resp = anon_client.get("/health/", HTTP_X_REQUEST_ID="abc-123-valid-id")
    assert resp["X-Request-ID"] == "abc-123-valid-id"
    resp = anon_client.get("/health/", HTTP_X_REQUEST_ID="<script>alert(1)</script>")
    assert resp["X-Request-ID"] != "<script>alert(1)</script>"


def test_problem_details_shape_and_no_internals(org_a, owner_client):
    resp = owner_client.post("/api/v1/teams/", {"name": ""}, format="json")
    assert resp.status_code == 400
    body = resp.json()
    assert set(body) >= {"type", "title", "status", "detail", "errors", "request_id"}
    assert body["errors"][0]["field"] == "name"
    resp = owner_client.get("/api/v1/teams/00000000-0000-0000-0000-000000000000/")
    assert resp.status_code == 404
    assert resp.json()["type"] == "not_found"
    text = resp.content.decode().lower()
    assert "traceback" not in text and "select " not in text


def test_unknown_route_returns_json_problem(anon_client):
    resp = anon_client.get("/api/v1/does-not-exist/")
    assert resp.status_code == 404
    assert resp.json()["type"] == "not_found"


def test_health_endpoints_reveal_nothing(anon_client):
    assert anon_client.get("/health/").json() == {"status": "ok"}
    assert anon_client.get("/ready/").json() == {"status": "ok"}


def test_oversized_json_rejected(org_a, owner_client, settings):
    payload = {"name": "x" * (settings.DATA_UPLOAD_MAX_MEMORY_SIZE + 10)}
    resp = owner_client.generic("POST", "/api/v1/teams/", json.dumps(payload), content_type="application/json")
    assert resp.status_code in (400, 413)


def test_unsupported_media_type(org_a, owner_client):
    resp = owner_client.generic("POST", "/api/v1/teams/", "name=x", content_type="application/x-www-form-urlencoded")
    assert resp.status_code == 415


def test_anonymous_throttle(monkeypatch):
    monkeypatch.setattr(AnonThrottle, "THROTTLE_RATES", {"anon": "2/min"})
    client = APIClient()
    codes = [client.get("/api/v1/invitations/preview/?token=abc").status_code for _ in range(3)]
    assert codes[-1] == 429
    assert client.get("/api/v1/invitations/preview/?token=abc")["Retry-After"]


def test_malicious_strings_are_stored_and_returned_escaped(org_a, owner_client):
    evil = "<script>alert(1)</script>'; DROP TABLE teams_team; --"
    resp = owner_client.post("/api/v1/teams/", {"name": evil}, format="json")
    assert resp.status_code == 201
    assert resp.json()["name"] == evil  # JSON-encoded, never rendered as HTML by the API
    assert owner_client.get("/api/v1/teams/").status_code == 200


def test_sequential_and_malformed_ids(org_a, owner_client):
    for bad in ["1", "0", "-1", "abc", "%00", "00000000-0000-0000-0000-000000000000"]:
        resp = owner_client.get(f"/api/v1/teams/{bad}/")
        assert resp.status_code == 404, bad
