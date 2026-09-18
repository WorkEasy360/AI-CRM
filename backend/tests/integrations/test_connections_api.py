"""Settings → Integrations API: catalog, generic REST connections, OAuth, sharing, disconnect."""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlsplit

import pytest
from django.core.cache import cache

from apps.contacts.models import Contact
from apps.core.tenancy.context import system_context, tenant_context
from apps.integrations import credentials
from apps.integrations.models import ConnectionStatus, IntegrationConnection, IntegrationRecordMap, SharingPolicy

pytestmark = pytest.mark.security

REST = {
    "provider": "generic_rest",
    "name": "Marketing platform",
    "auth_type": "api_key",
    "config": {"base_url": "https://api.example.com/v1", "conventions": {"health_path": "/me"}},
    "credentials": {"api_key": "sk_live_super_secret_value"},
}


def _create(client, **overrides):
    return client.post("/api/v1/integrations/connections/", {**REST, **overrides}, format="json")


def test_catalog_lists_existing_and_generic_integrations(owner_client):
    resp = owner_client.get("/api/v1/integrations/catalog/")
    assert resp.status_code == 200
    by_key = {item["key"]: item for item in resp.json()["results"]}
    assert {"google", "microsoft", "whatsapp", "generic_rest"} <= set(by_key)
    assert by_key["google"]["manage_url"] == "/settings/email"
    assert by_key["whatsapp"]["status"] == "available"


@pytest.mark.parametrize("role", ["sales_manager", "sales_rep", "viewer"])
def test_sales_roles_cannot_see_or_manage_integrations(org_a, make_member, client_for, reauthenticate, role):
    member = make_member(org_a, role)
    client = client_for(member.user, member)
    reauthenticate(client)
    assert client.get("/api/v1/integrations/catalog/").status_code == 403
    assert client.get("/api/v1/integrations/connections/").status_code == 403
    assert _create(client).status_code == 403


def test_connect_stores_encrypted_credentials_and_verifies_health(org_a, owner_client, reauthenticate, remote):
    remote.on("GET", "/v1/me", 200, {"ok": True})
    assert _create(owner_client).status_code == 403  # recent authentication required
    reauthenticate(owner_client)
    resp = _create(owner_client)
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["status"] == "connected"
    assert body["credentials_configured"] == ["api_key"]
    assert "sk_live_super_secret_value" not in json.dumps(body)
    assert remote.calls("GET", "/v1/me")[0].headers["x-api-key"] == "sk_live_super_secret_value"
    with tenant_context(org_a.org.pk):
        stored = IntegrationConnection.objects.get(pk=body["id"])
    assert "sk_live_super_secret_value" not in stored.credentials_enc
    assert credentials.unseal(stored.credentials_enc) == {"api_key": "sk_live_super_secret_value"}
    for view in (
        owner_client.get("/api/v1/integrations/connections/"),
        owner_client.get(f"/api/v1/integrations/connections/{body['id']}/"),
    ):
        assert "sk_live_super_secret_value" not in view.content.decode()
        assert "credentials_enc" not in view.content.decode()
    with system_context("test"):
        from apps.audit.models import AuditEvent

        audit_blob = json.dumps(list(AuditEvent.objects.values_list("metadata", flat=True)))
    assert "sk_live_super_secret_value" not in audit_blob


def test_rejected_credentials_show_human_message(owner_client, reauthenticate, remote):
    remote.on("GET", "/v1/me", 401, {"error": "invalid_api_key", "trace": "Traceback (most recent call last)"})
    reauthenticate(owner_client)
    body = _create(owner_client).json()
    assert body["status"] == "action_required"
    assert body["last_error_message"] == "Your Generic REST API connection has expired. Reconnect your account."
    assert "invalid_api_key" not in json.dumps(body) and "Traceback" not in json.dumps(body)


@pytest.mark.parametrize(
    "config",
    [
        {"base_url": "https://127.0.0.1/api"},
        {"base_url": "http://api.example.com"},
        {"base_url": "https://169.254.169.254/latest"},
        {"base_url": "https://api.example.com", "unexpected": "x"},
        {"base_url": "https://api.example.com", "conventions": {"health_path": "/../../admin"}},
        {"base_url": "https://api.example.com", "conventions": {"api_key_header": "Host"}},
    ],
)
def test_connection_config_is_validated(owner_client, reauthenticate, config):
    reauthenticate(owner_client)
    assert _create(owner_client, config=config).status_code == 400


def test_client_secret_never_accepted_as_config(owner_client, reauthenticate):
    reauthenticate(owner_client)
    resp = _create(
        owner_client,
        auth_type="oauth2_client_credentials",
        config={
            "base_url": "https://api.example.com",
            "oauth": {"client_id": "abc", "client_secret": "leak", "token_url": "https://auth.example.com/token"},
        },
        credentials={},
    )
    assert resp.status_code == 400


def test_sharing_rejects_prohibited_fields_and_requires_reauth_to_widen(
    org_a, owner_client, reauthenticate, crm, remote
):
    conn = crm.make_integration_connection(org_a)
    url = f"/api/v1/integrations/connections/{conn.pk}/sharing/"
    good = {
        "entity_type": "contact",
        "direction": "outbound",
        "external_resource": "/contacts",
        "mappings": [{"crm_field": "email", "external_field": "email"}],
    }
    assert owner_client.put(url, good, format="json").status_code == 403  # widening needs reauth
    reauthenticate(owner_client)
    for bad in (
        {**good, "mappings": [{"crm_field": "description", "external_field": "notes"}]},
        {**good, "mappings": [{"crm_field": "password", "external_field": "p"}]},
        {**good, "entity_type": "note"},
        {**good, "entity_type": "email"},
        {**good, "external_resource": "https://evil.example.com/steal"},
        {**good, "external_resource": "/../admin"},
        {**good, "mappings": []},
    ):
        assert owner_client.put(url, bad, format="json").status_code == 400, bad
    resp = owner_client.put(url, good, format="json")
    assert resp.status_code == 200
    assert resp.json()["sharing"] == [
        {
            "entity_type": "contact",
            "direction": "outbound",
            "external_resource": "/contacts",
            "mappings": good["mappings"],
        }
    ]


def test_options_expose_only_allowlisted_fields(owner_client, org_a, crm):
    crm.make_custom_field(org_a, entity_type="contact", key="secret_code", label="Secret")
    body = owner_client.get("/api/v1/integrations/options/").json()
    contact = next(e for e in body["entities"] if e["key"] == "contact")
    assert "email" in contact["outbound_fields"]
    assert not any("secret" in f or "password" in f or "owner" in f for f in contact["outbound_fields"])
    note = next(e for e in body["entities"] if e["key"] == "note")
    assert note["shareable"] is False and "outbound_fields" not in note
    assert "crm:everything" not in json.dumps(body["api_scopes"])


def test_disconnect_revokes_wipes_secrets_and_keeps_crm_data(
    org_a, owner_client, reauthenticate, crm, connection, remote
):
    contact = crm.make_contact(org_a)
    with tenant_context(org_a.org.pk):
        IntegrationConnection.objects.filter(pk=connection.pk).update(
            config={
                "base_url": "https://api.example.com/v1",
                "oauth": {
                    "client_id": "abc",
                    "token_url": "https://auth.example.com/token",
                    "revoke_url": "https://auth.example.com/revoke",
                },
            },
            auth_type="oauth2_code",
            credentials_enc=credentials.seal({"access_token": "at", "refresh_token": "rt", "client_secret": "cs"}),
        )
        IntegrationRecordMap.objects.create(
            connection=connection, entity_type="contact", crm_record_id=contact.pk, external_record_id="e1"
        )
    remote.on("POST", "/revoke", 200)
    reauthenticate(owner_client)
    resp = owner_client.post(f"/api/v1/integrations/connections/{connection.pk}/disconnect/", {}, format="json")
    assert resp.status_code == 200 and resp.json()["status"] == "disconnected"
    assert remote.calls("POST", "/revoke")
    with tenant_context(org_a.org.pk):
        connection.refresh_from_db()
        assert connection.credentials_enc == "" and connection.inbound_secret_enc == ""
        assert Contact.objects.filter(pk=contact.pk).exists()
        assert SharingPolicy.objects.filter(connection=connection).exists()  # configuration kept for reconnect
    # sync refuses to run while disconnected
    assert (
        owner_client.post(f"/api/v1/integrations/connections/{connection.pk}/sync/", {}, format="json").status_code
        == 409
    )


def test_oauth_state_is_single_use_and_bound_to_member(
    org_a, owner_client, reauthenticate, crm, remote, make_member, client_for
):
    conn = crm.make_integration_connection(
        org_a,
        auth_type="oauth2_code",
        status=ConnectionStatus.ACTION_REQUIRED,
        config={
            "base_url": "https://api.example.com/v1",
            "oauth": {
                "client_id": "client-1",
                "authorize_url": "https://auth.example.com/authorize",
                "token_url": "https://auth.example.com/token",
                "scopes": ["contacts.read"],
            },
            "conventions": {"health_path": "/me"},
        },
        credentials_enc=credentials.seal({"client_secret": "cs"}),
    )
    reauthenticate(owner_client)
    start = owner_client.post(f"/api/v1/integrations/connections/{conn.pk}/oauth/start/", {}, format="json")
    assert start.status_code == 200
    query = parse_qs(urlsplit(start.json()["authorization_url"]).query)
    assert query["code_challenge_method"] == ["S256"] and query["client_id"] == ["client-1"]
    state = query["state"][0]

    # another admin cannot complete someone else's flow
    other = make_member(org_a, "admin")
    other_resp = client_for(other.user, other).get(f"/api/v1/integrations/oauth/callback/?state={state}&code=abc")
    assert other_resp.status_code == 302 and "oauth=error" in other_resp["Location"]

    cache.set(
        f"oauth:integration:{state}",
        {
            "organization_id": str(org_a.org.pk),
            "membership_id": str(org_a.owner_membership.pk),
            "connection_id": str(conn.pk),
            "verifier": "v" * 64,
        },
        600,
    )
    remote.on("POST", "/token", 200, {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600})
    remote.on("GET", "/v1/me", 200, {})
    done = owner_client.get(f"/api/v1/integrations/oauth/callback/?state={state}&code=abc")
    assert done.status_code == 302 and "oauth=connected" in done["Location"]
    token_request = remote.calls("POST", "/token")[0]
    form = parse_qs(token_request.content.decode())
    assert form["code_verifier"] == ["v" * 64] and form["grant_type"] == ["authorization_code"]
    with tenant_context(org_a.org.pk):
        conn.refresh_from_db()
    assert conn.status == ConnectionStatus.CONNECTED
    assert "new-access" not in conn.credentials_enc
    assert credentials.unseal(conn.credentials_enc)["refresh_token"] == "new-refresh"
    # replaying the same state fails
    again = owner_client.get(f"/api/v1/integrations/oauth/callback/?state={state}&code=abc")
    assert "oauth=error" in again["Location"]


def test_foreign_organization_connection_is_invisible(org_a, org_b, crm, owner_client, reauthenticate):
    foreign = crm.make_integration_connection(org_b)
    reauthenticate(owner_client)
    for method, suffix in (
        ("get", ""),
        ("post", "test/"),
        ("post", "disconnect/"),
        ("post", "inbound/"),
        ("get", "jobs/"),
    ):
        resp = getattr(owner_client, method)(
            f"/api/v1/integrations/connections/{foreign.pk}/{suffix}", {}, format="json"
        )
        assert resp.status_code == 404, suffix
    with tenant_context(org_b.org.pk):
        foreign.refresh_from_db()
        assert foreign.status == ConnectionStatus.CONNECTED and foreign.credentials_enc
