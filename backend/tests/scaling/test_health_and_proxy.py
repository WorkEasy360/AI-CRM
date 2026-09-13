"""Health probes and proxy-awareness: what a load balancer needs, and what it must never get."""

from __future__ import annotations

import pytest
from django.http import HttpResponse
from django.test import RequestFactory

from apps.core import health
from security.middleware import ClientIPMiddleware
from security.throttles import AnonThrottle

pytestmark = pytest.mark.security


@pytest.mark.parametrize("path", ["/health/live/", "/health/", "/health/ready/", "/ready/"])
def test_probes_reveal_nothing_and_carry_security_headers(db, anon_client, path):
    resp = anon_client.get(path)
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert resp["Cache-Control"] == "no-store"
    assert resp["X-Content-Type-Options"] == "nosniff"
    assert resp["X-Request-ID"]


def test_probes_accept_load_balancer_host_header(db, anon_client):
    """ALB probes use the target IP as Host; ALLOWED_HOSTS must not turn every probe into a 400."""
    assert anon_client.get("/health/ready/", HTTP_HOST="10.0.12.34:8000").status_code == 200
    assert anon_client.get("/health/live/", HTTP_HOST="10.0.12.34:8000").status_code == 200
    # Only probe paths are exempt: the API still enforces ALLOWED_HOSTS.
    assert anon_client.get("/api/v1/session/", HTTP_HOST="10.0.12.34:8000").status_code == 400


def test_probe_paths_are_get_only(db, anon_client):
    assert anon_client.post("/health/ready/").status_code == 405


def test_ready_is_503_when_database_check_fails(db, anon_client, monkeypatch):
    monkeypatch.setattr(health, "_check_database", lambda: False)
    resp = anon_client.get("/health/ready/")
    assert resp.status_code == 503
    assert resp.json() == {"status": "unavailable"}  # which dependency failed is logged, not returned


def test_ready_stays_up_when_cache_is_down(db, anon_client, monkeypatch):
    monkeypatch.setattr(health, "_check_cache", lambda: False)
    assert anon_client.get("/health/ready/").status_code == 200


def test_forwarded_ready_requests_do_not_touch_dependencies(db, anon_client, monkeypatch, settings):
    """A readiness probe reachable through the edge must not become a database-hammering endpoint."""
    settings.HEALTH_READY_INTERNAL_ONLY = True

    def boom():
        raise AssertionError("dependency check ran for a forwarded request")

    monkeypatch.setattr(health, "_check_database", boom)
    resp = anon_client.get("/health/ready/", HTTP_X_FORWARDED_FOR="203.0.113.7")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def _remote_addr(settings, hops: int, forwarded: str | None) -> str:
    settings.TRUSTED_PROXY_COUNT = hops
    factory = RequestFactory()
    request = factory.get("/api/v1/session/", REMOTE_ADDR="10.0.0.9")
    if forwarded is not None:
        request.META["HTTP_X_FORWARDED_FOR"] = forwarded
    seen = {}

    def view(req):
        seen["ip"] = req.META["REMOTE_ADDR"]
        return HttpResponse()

    ClientIPMiddleware(view)(request)
    return seen["ip"]


def test_client_ip_uses_rightmost_trusted_hop(settings):
    # CloudFront + ALB: the client may prepend anything, the two trusted hops append the truth.
    assert _remote_addr(settings, 2, "6.6.6.6, 198.51.100.4, 13.32.0.1") == "198.51.100.4"
    assert _remote_addr(settings, 1, "6.6.6.6, 198.51.100.4") == "198.51.100.4"


def test_client_ip_ignores_spoofed_header_without_the_expected_hops(settings):
    # Fewer entries than trusted hops: keep the peer (proxy) address instead of trusting the client.
    assert _remote_addr(settings, 2, "6.6.6.6") == "10.0.0.9"
    # No proxies configured (development): the header is ignored entirely.
    assert _remote_addr(settings, 0, "6.6.6.6") == "10.0.0.9"
    assert _remote_addr(settings, 2, None) == "10.0.0.9"


def test_anon_throttle_keys_on_resolved_client_not_on_header():
    """With NUM_PROXIES=0 DRF must key throttles on REMOTE_ADDR, never on a client-controlled header."""
    request = RequestFactory().get("/api/v1/session/", REMOTE_ADDR="10.0.0.9", HTTP_X_FORWARDED_FOR="1.2.3.4, 5.6.7.8")
    assert AnonThrottle().get_ident(request) == "10.0.0.9"
