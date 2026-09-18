"""SSRF: organizations configure destinations, so every destination is untrusted input."""

from __future__ import annotations

import httpx
import pytest

from apps.integrations import net

pytestmark = pytest.mark.security

BLOCKED_URLS = [
    "http://api.example.com/hook",  # plain http
    "ftp://api.example.com/hook",
    "file:///etc/passwd",
    "gopher://api.example.com/",
    "https://localhost/hook",
    "https://LOCALHOST./hook",
    "https://127.0.0.1/hook",
    "https://127.1/hook",
    "https://2130706433/hook",  # decimal 127.0.0.1
    "https://0x7f.0.0.1/hook",
    "https://0177.0.0.1/hook",  # octal
    "https://0.0.0.0/hook",
    "https://10.1.2.3/hook",
    "https://172.16.5.4/hook",
    "https://192.168.0.10/hook",
    "https://100.64.0.1/hook",  # carrier-grade NAT
    "https://169.254.169.254/latest/meta-data/",  # AWS / GCP / Azure metadata
    "https://169.254.170.2/v2/credentials",  # ECS task credentials
    "https://100.100.100.200/latest/meta-data/",  # Alibaba metadata
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://instance-data/latest/",
    "https://[::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://[::ffff:169.254.169.254]/hook",
    "https://[fd00:ec2::254]/latest/meta-data/",
    "https://[fe80::1]/hook",
    "https://service.internal/hook",
    "https://printer.local/hook",
    "https://intranet/hook",  # single-label name
    "https://user:pass@api.example.com/hook",  # credentials in URL
    "https://api.example.com@127.0.0.1/hook",
    "https://api.example.com:22/hook",  # unexpected port
    "https://api.example.com:6379/",
    "https://api.example.com/hook\r\nX-Injected: 1",
]


@pytest.mark.parametrize("url", BLOCKED_URLS)
def test_blocked_destinations(url):
    with pytest.raises(net.UnsafeDestination):
        target = net.validate_url(url)
        net.resolve(target.host, target.port)


@pytest.mark.parametrize("url", ["https://api.example.com/v1", "https://hooks.example.org:8443/x?y=1"])
def test_public_destinations_are_allowed(url):
    target = net.validate_url(url)
    assert net.resolve(target.host, target.port)


@pytest.mark.parametrize("private", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "fd12:3456::1"])
def test_hostname_resolving_to_private_address_is_blocked(fake_dns, private):
    """DNS answers are checked, not just literal IPs (rebinding to internal addresses)."""
    fake_dns["rebind.example.com"] = [private]
    with pytest.raises(net.UnsafeDestination):
        net.safe_request("GET", "https://rebind.example.com/")


def test_any_private_answer_among_several_is_blocked(fake_dns):
    fake_dns["mixed.example.com"] = ["93.184.216.34", "10.0.0.1"]
    with pytest.raises(net.UnsafeDestination):
        net.safe_request("GET", "https://mixed.example.com/")


def test_connection_is_pinned_to_the_checked_address(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={})

    monkeypatch.setattr(net, "transport_override", httpx.MockTransport(handler))
    net.safe_request("GET", "https://api.example.com/ping")
    assert seen[0].url.host == "93.184.216.34"
    assert seen[0].headers["host"] == "api.example.com"
    assert seen[0].extensions["sni_hostname"] == "api.example.com"


@pytest.mark.parametrize(
    "location", ["http://127.0.0.1/admin", "https://169.254.169.254/latest/meta-data/", "https://api.example.com/other"]
)
def test_redirects_are_never_followed(monkeypatch, location):
    calls: list[str] = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": location})

    monkeypatch.setattr(net, "transport_override", httpx.MockTransport(handler))
    with pytest.raises(net.UnsafeDestination) as exc:
        net.safe_request("POST", "https://api.example.com/hook", content=b"{}")
    assert exc.value.code == "redirect_not_followed"
    assert len(calls) == 1


def test_oversized_response_is_cut_off(monkeypatch):
    monkeypatch.setattr(
        net, "transport_override", httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 5000))
    )
    with pytest.raises(net.TransportError) as exc:
        net.safe_request("GET", "https://api.example.com/", max_bytes=1000)
    assert exc.value.code == "response_too_large"


def test_http_allowed_only_when_explicitly_enabled(settings):
    with pytest.raises(net.UnsafeDestination):
        net.validate_url("http://api.example.com/")
    settings.INTEGRATIONS_ALLOW_HTTP = True
    assert net.validate_url("http://api.example.com/").scheme == "http"
    # still never to private addresses
    with pytest.raises(net.UnsafeDestination):
        net.validate_url("http://127.0.0.1/")
