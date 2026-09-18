"""Outbound HTTP for integrations and webhooks, hardened against SSRF.

Every request to a destination an organization configured (webhook URL, REST base URL, OAuth token
endpoint) goes through ``safe_request``:

- scheme ``https`` only (``http`` only when ``INTEGRATIONS_ALLOW_HTTP`` is on, for local development)
- no credentials in the URL, only allowed ports, no hostnames under internal suffixes
- the hostname is resolved once and *every* address must be public (not loopback, private, link-local,
  CGNAT, multicast, reserved, unspecified, IPv4-mapped/6to4 private or a cloud metadata address)
- the connection goes to the checked IP (the Host header and TLS SNI/verification keep the name), so a
  DNS answer that changes between check and connect (rebinding) cannot redirect the request
- redirects are never followed; timeouts are short; response bodies are capped; proxies from the
  environment are ignored
"""

from __future__ import annotations

import ipaddress
import socket
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from django.conf import settings

MAX_URL_LENGTH = 2048
DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
DEFAULT_MAX_BYTES = 1024 * 1024
USER_AGENT = "Keel-Integrations/1.0"

BLOCKED_HOSTNAMES = frozenset(
    {
        "localhost",
        "metadata",
        "metadata.google.internal",
        "metadata.goog",
        "instance-data",
        "instance-data.ec2.internal",
        "kubernetes.default",
        "kubernetes.default.svc",
    }
)
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".svc", ".cluster.local")
METADATA_ADDRESSES = frozenset(
    ipaddress.ip_address(a)
    for a in ("169.254.169.254", "169.254.170.2", "100.100.100.200", "192.0.0.192", "fd00:ec2::254")
)

# Tests replace this with an ``httpx.MockTransport``; production always uses the default transport.
transport_override: httpx.BaseTransport | None = None


class UnsafeDestination(Exception):  # noqa: N818 - reads as a sentence at call sites
    """The URL is not an allowed external destination. Never retry."""

    def __init__(self, code: str, message: str = "This address is not allowed."):
        super().__init__(message)
        self.code = code
        self.message = message


class TransportError(Exception):
    """Network-level failure (timeout, connection refused, TLS). Usually retryable."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class SafeResponse:
    status_code: int
    headers: dict[str, str]
    content: bytes = b""
    elapsed_ms: int = 0
    extra: dict[str, Any] = field(default_factory=dict)

    def json(self) -> Any:
        import json

        return json.loads(self.content.decode("utf-8"))


def _allowed_schemes() -> set[str]:
    return {"https", "http"} if getattr(settings, "INTEGRATIONS_ALLOW_HTTP", False) else {"https"}


def _allowed_ports(scheme: str) -> set[int]:
    configured = getattr(settings, "INTEGRATIONS_ALLOWED_PORTS", None)
    if configured:
        return {int(p) for p in configured}
    return {443, 8443} if scheme == "https" else {80, 8080}


def ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip in METADATA_ADDRESSES:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        for embedded in (ip.ipv4_mapped, ip.sixtofour, (ip.teredo or (None, None))[1]):
            if embedded is not None and not ip_is_public(embedded):
                return False
    return bool(
        ip.is_global
        and not ip.is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_multicast
        and not ip.is_reserved
        and not ip.is_unspecified
    )


@dataclass(frozen=True)
class Target:
    scheme: str
    host: str
    port: int
    path: str
    query: str


def validate_url(url: str) -> Target:
    """Syntactic and policy checks that need no network access (also used when saving settings)."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise UnsafeDestination("invalid_url", "Enter a valid URL.")
    if any(ch in url for ch in ("\r", "\n", "\t", " ", "\\")):
        raise UnsafeDestination("invalid_url", "Enter a valid URL.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise UnsafeDestination("invalid_url", "Enter a valid URL.") from exc
    scheme = (parts.scheme or "").lower()
    if scheme not in _allowed_schemes():
        raise UnsafeDestination("scheme_not_allowed", "Only https:// addresses are allowed.")
    if parts.username is not None or parts.password is not None or "@" in (parts.netloc or ""):
        raise UnsafeDestination("credentials_in_url", "Do not put credentials in the URL.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise UnsafeDestination("invalid_url", "Enter a valid URL.")
    port = port or (443 if scheme == "https" else 80)
    if port not in _allowed_ports(scheme):
        raise UnsafeDestination("port_not_allowed", "This port is not allowed.")
    if host in BLOCKED_HOSTNAMES or host.endswith(BLOCKED_SUFFIXES):
        raise UnsafeDestination("private_destination", "Internal addresses are not allowed.")
    literal = _parse_ip_literal(host)
    if literal is not None:
        if not ip_is_public(literal):
            raise UnsafeDestination("private_destination", "Internal addresses are not allowed.")
    elif "." not in host:
        raise UnsafeDestination("private_destination", "Use a fully qualified public hostname.")
    return Target(scheme=scheme, host=host, port=port, path=parts.path or "/", query=parts.query)


def _parse_ip_literal(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    candidate = host.strip("[]")
    try:
        return ipaddress.ip_address(candidate)
    except ValueError:
        pass
    # Integer / octal / hex / shortened IPv4 forms ("2130706433", "0x7f.1", "127.1") that resolvers accept.
    if all(c in "0123456789abcdefxo." for c in candidate) and any(c.isdigit() for c in candidate):
        try:
            packed = socket.inet_aton(candidate)
        except OSError:
            return None
        return ipaddress.IPv4Address(packed)
    return None


def resolve(host: str, port: int) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Resolve ``host``; raise unless every returned address is public. Patched in tests."""
    literal = _parse_ip_literal(host)
    if literal is not None:
        addresses = [literal]
    else:
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except (socket.gaierror, UnicodeError) as exc:
            raise TransportError("dns_failure") from exc
        addresses = [ipaddress.ip_address(str(info[4][0]).split("%", 1)[0]) for info in infos]
    if not addresses:
        raise TransportError("dns_failure")
    if not all(ip_is_public(ip) for ip in addresses):
        raise UnsafeDestination("private_destination", "This address resolves to a private network.")
    return addresses


def safe_request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    content: bytes | None = None,
    json_body: Any = None,
    form: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
    timeout: httpx.Timeout = DEFAULT_TIMEOUT,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> SafeResponse:
    target = validate_url(url)
    addresses = resolve(target.host, target.port)
    ip = addresses[0]
    ip_host = f"[{ip}]" if ip.version == 6 else str(ip)
    default_port = 443 if target.scheme == "https" else 80
    netloc = ip_host if target.port == default_port else f"{ip_host}:{target.port}"
    pinned_url = urlunsplit((target.scheme, netloc, target.path, target.query, ""))
    host_header = target.host if target.port == default_port else f"{target.host}:{target.port}"
    request_headers = {"User-Agent": USER_AGENT, **(headers or {}), "Host": host_header}

    started = time.monotonic()
    try:
        with (
            httpx.Client(
                timeout=timeout,
                follow_redirects=False,
                trust_env=False,
                transport=transport_override,
            ) as client,
            client.stream(
                method,
                pinned_url,
                headers=request_headers,
                content=content,
                json=json_body,
                data=form,
                params=params,
                extensions={"sni_hostname": target.host},
            ) as response,
        ):
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise TransportError("response_too_large")
            result = SafeResponse(
                status_code=response.status_code,
                headers={k.lower(): v for k, v in response.headers.items()},
                content=bytes(body),
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
    except httpx.TimeoutException as exc:
        raise TransportError("timeout") from exc
    except httpx.HTTPError as exc:
        raise TransportError("connection_failed") from exc
    if 300 <= result.status_code < 400:
        # Never followed: a redirect could point anywhere, including an internal address.
        raise UnsafeDestination("redirect_not_followed", "The destination answered with a redirect.")
    return result


def retry_after_seconds(response: SafeResponse, *, cap: int = 3600) -> int | None:
    raw = response.headers.get("retry-after", "").strip()
    if not raw:
        return None
    if raw.isdigit():
        return min(int(raw), cap)
    from email.utils import parsedate_to_datetime

    from django.utils import timezone

    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    return max(0, min(int((when - timezone.now()).total_seconds()), cap))
