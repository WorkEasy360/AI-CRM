"""Scoped machine credentials for external software calling the Keel API."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.audit.models import AuditEvent
from apps.contacts.models import Contact
from apps.core.tenancy.context import system_context, tenant_context
from apps.integrations import throttles
from apps.integrations.models import ApiCredential

pytestmark = pytest.mark.security


@pytest.fixture
def make_key(owner_client, reauthenticate):
    reauthenticate(owner_client)

    def _make(scopes, **extra):
        resp = owner_client.post(
            "/api/v1/integrations/api-credentials/",
            {"name": "Marketing sync", "scopes": scopes, **extra},
            format="json",
        )
        assert resp.status_code == 201, resp.content
        return resp.json()

    return _make


def machine(key: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {key}")
    return client


def test_key_is_shown_once_and_stored_hashed(org_a, owner_client, make_key):
    created = make_key(["contacts:read"])
    key = created["key"]
    assert key.startswith("keel_")
    listed = owner_client.get("/api/v1/integrations/api-credentials/").json()["results"]
    assert key not in json.dumps(listed)
    assert "secret_hash" not in listed[0] and listed[0]["display_key"].endswith("••••")
    with tenant_context(org_a.org.pk):
        stored = ApiCredential.objects.get(pk=created["id"])
    assert key.rsplit("_", 1)[-1] not in stored.secret_hash
    assert stored.expires_at is not None  # 90 days by default


def test_creating_credentials_requires_reauth_and_admin(org_a, owner_client, make_member, client_for):
    assert (
        owner_client.post(
            "/api/v1/integrations/api-credentials/", {"name": "x", "scopes": ["contacts:read"]}, format="json"
        ).status_code
        == 403
    )
    rep = make_member(org_a, "sales_manager")
    client = client_for(rep.user, rep)
    assert client.get("/api/v1/integrations/api-credentials/").status_code == 403


def test_no_catch_all_scope(make_key, owner_client):
    for scopes in (["crm:everything"], ["*"], ["contacts:*"], [], ["admin"]):
        resp = owner_client.post(
            "/api/v1/integrations/api-credentials/", {"name": "x", "scopes": scopes}, format="json"
        )
        assert resp.status_code == 400, scopes


def test_read_scope_reads_but_cannot_write(org_a, crm, make_key):
    contact = crm.make_contact(org_a, first_name="Ada")
    client = machine(make_key(["contacts:read"])["key"])
    listed = client.get("/api/v1/contacts/")
    assert listed.status_code == 200
    assert str(contact.pk) in {c["id"] for c in listed.json()["results"]}
    assert client.post("/api/v1/contacts/", {"first_name": "New"}, format="json").status_code == 403
    assert client.get("/api/v1/companies/").status_code == 403  # wrong scope
    assert client.delete(f"/api/v1/contacts/{contact.pk}/").status_code == 403  # no delete scope exists
    assert client.get("/api/v1/contacts/export/").status_code in (403, 404, 405)


def test_write_scope_creates_through_service_layer_and_audits_as_integration(org_a, make_key):
    created = make_key(["contacts:write"])
    resp = machine(created["key"]).post(
        "/api/v1/contacts/", {"first_name": "Api", "email": "api@example.com"}, format="json"
    )
    assert resp.status_code == 201, resp.content
    assert "set-cookie" not in {k.lower() for k in resp.headers}
    with system_context("test"):
        event = AuditEvent.objects.get(action="contacts.created", resource_id=resp.json()["id"])
    assert event.actor_type == "integration"
    assert event.metadata["integration_id"] == created["id"]


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/session/",
        "/api/v1/members/",
        "/api/v1/invitations/",
        "/api/v1/organizations/current/",
        "/api/v1/integrations/api-credentials/",
        "/api/v1/integrations/connections/",
        "/api/v1/audit-events/",
        "/api/v1/assistant/home/",
        "/_allauth/browser/v1/auth/session",
    ],
)
def test_credentials_are_refused_outside_crm_record_apis(make_key, path):
    client = machine(make_key(["contacts:read", "contacts:write"])["key"])
    resp = client.get(path)
    assert resp.status_code == 403
    assert resp.json()["type"] == "machine_credential_not_allowed"


def test_expired_revoked_and_invalid_credentials(org_a, owner_client, make_key):
    created = make_key(["contacts:read"])
    client = machine(created["key"])
    assert client.get("/api/v1/contacts/").status_code == 200

    with tenant_context(org_a.org.pk):
        ApiCredential.objects.filter(pk=created["id"]).update(expires_at=timezone.now() - timedelta(seconds=1))
    assert client.get("/api/v1/contacts/").status_code == 401
    with tenant_context(org_a.org.pk):
        ApiCredential.objects.filter(pk=created["id"]).update(expires_at=None)
    assert client.get("/api/v1/contacts/").status_code == 200

    assert owner_client.delete(f"/api/v1/integrations/api-credentials/{created['id']}/").status_code == 204
    resp = client.get("/api/v1/contacts/")
    assert resp.status_code == 401 and resp.headers["WWW-Authenticate"].startswith("Bearer")

    tampered = created["key"][:-1] + ("A" if created["key"][-1] != "A" else "B")
    assert machine(tampered).get("/api/v1/contacts/").status_code == 401
    assert machine("keel_nothex_garbage").get("/api/v1/contacts/").status_code == 401


def test_credential_stops_when_creator_loses_access(org_a, make_member, client_for, reauthenticate, owner_client):
    admin = make_member(org_a, "admin")
    admin_client = client_for(admin.user, admin)
    reauthenticate(admin_client)
    key = admin_client.post(
        "/api/v1/integrations/api-credentials/", {"name": "x", "scopes": ["contacts:read"]}, format="json"
    ).json()["key"]
    assert machine(key).get("/api/v1/contacts/").status_code == 200
    reauthenticate(owner_client)
    assert owner_client.post(f"/api/v1/members/{admin.pk}/suspend/", {}, format="json").status_code == 200
    assert machine(key).get("/api/v1/contacts/").status_code == 401


def test_credential_cannot_reach_another_tenant(org_a, org_b, crm, make_key):
    foreign = crm.make_contact(org_b, first_name="Bob")
    client = machine(make_key(["contacts:read", "contacts:write"])["key"])
    assert client.get(f"/api/v1/contacts/{foreign.pk}/").status_code == 404
    assert client.patch(f"/api/v1/contacts/{foreign.pk}/", {"first_name": "Hacked"}, format="json").status_code == 404
    assert str(foreign.pk) not in {c["id"] for c in client.get("/api/v1/contacts/").json()["results"]}
    # forged organization headers or body fields change nothing
    resp = client.post(
        "/api/v1/contacts/",
        {"first_name": "Forged", "organization_id": str(org_b.org.pk), "organization": str(org_b.org.pk)},
        format="json",
        HTTP_X_ORGANIZATION_ID=str(org_b.org.pk),
    )
    assert resp.status_code == 201
    with tenant_context(org_a.org.pk):
        assert Contact.objects.filter(pk=resp.json()["id"]).exists()
    with tenant_context(org_b.org.pk):
        foreign.refresh_from_db()
        assert foreign.first_name == "Bob"
        assert not Contact.objects.filter(first_name="Forged").exists()


def test_session_plus_credential_is_ambiguous(org_a, owner_client, make_key):
    key = make_key(["contacts:read"])["key"]
    owner_client.credentials(HTTP_AUTHORIZATION=f"Bearer {key}")
    resp = owner_client.get("/api/v1/contacts/")
    assert resp.status_code == 400 and resp.json()["type"] == "ambiguous_authentication"


def test_machine_rate_limits(org_a, make_key, monkeypatch):
    client = machine(make_key(["contacts:read"])["key"])
    monkeypatch.setattr(throttles.MachineCredentialThrottle, "rate", "3/min", raising=False)
    statuses = [client.get("/api/v1/contacts/").status_code for _ in range(5)]
    assert statuses[:3] == [200, 200, 200] and statuses[3:] == [429, 429]


def test_endpoint_rate_limit_is_per_endpoint(org_a, make_key, monkeypatch):
    client = machine(make_key(["contacts:read", "companies:read"])["key"])
    monkeypatch.setattr(throttles.MachineEndpointThrottle, "rate", "2/min", raising=False)
    assert [client.get("/api/v1/contacts/").status_code for _ in range(3)] == [200, 200, 429]
    assert client.get("/api/v1/companies/").status_code == 200


def test_session_requests_are_not_affected_by_machine_throttles(owner_client, monkeypatch):
    monkeypatch.setattr(throttles.MachineCredentialThrottle, "rate", "1/min", raising=False)
    assert [owner_client.get("/api/v1/contacts/").status_code for _ in range(3)] == [200, 200, 200]


def test_browser_requests_keep_their_unauthenticated_status(db, anon_client):
    """Adding machine authentication must not change what signed-out browsers get (403, no Bearer challenge)."""
    resp = anon_client.get("/api/v1/contacts/")
    assert resp.status_code == 403
    assert resp.json()["type"] == "not_authenticated"
    assert "WWW-Authenticate" not in resp.headers
