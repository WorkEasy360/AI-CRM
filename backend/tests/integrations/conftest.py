"""Fixtures for Integration Hub tests: a fake DNS, a fake remote HTTP server and ready-made connections."""

from __future__ import annotations

import json
import socket
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from apps.core.tenancy.context import tenant_context
from apps.integrations import net
from apps.integrations.models import Direction, FieldMapping, SharingPolicy

PUBLIC_IP = "93.184.216.34"


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    """Every hostname resolves to a public address unless a test maps it elsewhere."""
    table: dict[str, list[str]] = {}

    def getaddrinfo(host, port, *args, **kwargs):
        addresses = table.get(host, [PUBLIC_IP])
        family = socket.AF_INET6 if ":" in addresses[0] else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (a, port)) for a in addresses]

    monkeypatch.setattr(net.socket, "getaddrinfo", getaddrinfo)
    return table


@dataclass
class Remote:
    """Scripted external system. ``routes[(METHOD, path)]`` -> handler(request) -> httpx.Response."""

    routes: dict[tuple[str, str], Callable[[httpx.Request], httpx.Response]] = field(default_factory=dict)
    requests: list[httpx.Request] = field(default_factory=list)

    def on(self, method: str, path: str, status: int = 200, body: Any = None, headers: dict[str, str] | None = None):
        def handler(request: httpx.Request) -> httpx.Response:
            content = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
            return httpx.Response(
                status, content=content, headers={"content-type": "application/json", **(headers or {})}
            )

        self.routes[(method.upper(), path)] = handler
        return self

    def handle(self, method: str, path: str, handler: Callable[[httpx.Request], httpx.Response]):
        self.routes[(method.upper(), path)] = handler
        return self

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        handler = self.routes.get((request.method, request.url.path))
        if handler is None:
            return httpx.Response(404, json={"error": "no route"})
        return handler(request)

    def calls(self, method: str, path: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == method.upper() and r.url.path == path]


@pytest.fixture
def remote(monkeypatch):
    server = Remote()
    monkeypatch.setattr(net, "transport_override", httpx.MockTransport(server))
    return server


@pytest.fixture
def connection(org_a, crm, remote):
    """A connected generic REST connection (API key) sharing contacts two-way."""
    conn = crm.make_integration_connection(org_a)
    with tenant_context(org_a.org.pk, reason="test.sharing"):
        SharingPolicy.objects.create(
            connection=conn, entity_type="contact", direction=Direction.TWO_WAY, external_resource="/contacts"
        )
        for crm_field, external in (("first_name", "firstName"), ("last_name", "lastName"), ("email", "emailAddress")):
            FieldMapping.objects.create(
                connection=conn, entity_type="contact", crm_field=crm_field, external_field=external
            )
    return conn


def json_body(request: httpx.Request) -> Any:
    return json.loads(request.content.decode("utf-8"))
