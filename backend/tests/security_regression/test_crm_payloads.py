"""Hostile payloads across the CRM surface: XSS, SQL injection, filter/sort injection, mass assignment."""

from __future__ import annotations

import pytest

pytestmark = [pytest.mark.django_db, pytest.mark.security]

XSS = "<script>alert(document.cookie)</script><img src=x onerror=alert(1)>"
SQLI = "'); DROP TABLE contacts_contact; --"
PAYLOADS = [XSS, SQLI, "{{7*7}}", "${jndi:ldap://x}", "\u202e" + chr(0) + "evil", "=1+1", "%00%0d%0a", "a' OR '1'='1"]


@pytest.mark.parametrize("payload", PAYLOADS)
def test_text_fields_store_payloads_verbatim_as_json(org_a, owner_client, crm, payload):
    stripped = payload.replace("\x00", "")
    resp = owner_client.post(
        "/api/v1/companies/", {"name": payload, "industry": payload, "description": payload}, format="json"
    )
    if chr(0) in payload:
        # DRF refuses NUL bytes outright (null_characters_not_allowed); that is the desired outcome.
        assert resp.status_code == 400 and resp["Content-Type"].startswith("application/json")
        return
    assert resp.status_code == 201, resp.content
    assert resp["Content-Type"].startswith("application/json")
    body = resp.json()
    assert body["name"] == stripped.strip() and body["description"] == stripped.strip()
    resp = owner_client.post(
        "/api/v1/contacts/", {"first_name": payload, "job_title": payload, "company_id": body["id"]}, format="json"
    )
    assert resp.status_code == 201
    resp = owner_client.post("/api/v1/deals/", {"name": payload, "description": payload}, format="json")
    assert resp.status_code == 201
    resp = owner_client.post(
        "/api/v1/notes/", {"entity_type": "deal", "entity_id": resp.json()["id"], "body": payload}, format="json"
    )
    assert resp.status_code == 201
    resp = owner_client.post("/api/v1/tags/", {"name": payload[:40]}, format="json")
    assert resp.status_code in (201, 400)
    resp = owner_client.get("/api/v1/companies/", {"q": payload})
    assert resp.status_code == 200
    resp = owner_client.get("/api/v1/search/", {"q": payload})
    assert resp.status_code == 200
    assert "traceback" not in resp.content.decode().lower()


def test_filter_and_sort_injection_is_rejected(org_a, owner_client):
    for params in [
        {"sort": "name) UNION SELECT password FROM accounts_user --"},
        {"sort": "owner__user__password"},
        {"sort": "?"},
        {"owner__user__email": "x"},
        {"filter[owner__user__is_staff]": "1"},
        {"custom.__class__": "x"},
        {"custom.a); DROP TABLE": "x"},
        {"ids": "1,2,3"},
        {"created_from": "2026-13-45"},
        {"amount_min": "NaN"},
        {"status": "open' OR 1=1"},
    ]:
        resp = owner_client.get("/api/v1/deals/", params)
        assert resp.status_code == 400, params
        assert resp.json()["type"] == "invalid"


def test_mass_assignment_is_ignored_or_rejected(org_a, owner_client, crm, make_member):
    other = make_member(org_a, "sales_rep")
    deal = crm.make_deal(org_a, owner=other)
    resp = owner_client.patch(
        f"/api/v1/deals/{deal.pk}/",
        {
            "version": 1,
            "status": "won",
            "closed_at": "2020-01-01T00:00:00Z",
            "amount_base": "999999",
            "stage_entered_at": "2020-01-01T00:00:00Z",
            "created_by": "x",
            "organization_id": "x",
            "search_vector": "x",
        },
        format="json",
    )
    assert resp.status_code in (200, 400)
    body = owner_client.get(f"/api/v1/deals/{deal.pk}/").json()
    assert body["status"] == "open" and body["closed_at"] is None and body["amount_base"] == "1000.00"


def test_version_header_hardening(org_a, owner_client, crm):
    contact = crm.make_contact(org_a)
    assert (
        owner_client.patch(
            f"/api/v1/contacts/{contact.pk}/", {"first_name": "x"}, format="json", HTTP_IF_MATCH="abc"
        ).status_code
        == 428
    )
    assert (
        owner_client.patch(
            f"/api/v1/contacts/{contact.pk}/", {"first_name": "x"}, format="json", HTTP_IF_MATCH='"99999999999"'
        ).status_code
        == 428
    )
    assert (
        owner_client.patch(
            f"/api/v1/contacts/{contact.pk}/", {"first_name": "x", "version": "one"}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.patch(
            f"/api/v1/contacts/{contact.pk}/", {"first_name": "x", "version": 0}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.patch(
            f"/api/v1/contacts/{contact.pk}/", {"first_name": "x", "version": 1}, format="json"
        ).status_code
        == 200
    )


def test_csv_download_headers(org_a, owner_client, reauthenticate, django_capture_on_commit_callbacks):
    reauthenticate(owner_client)
    with django_capture_on_commit_callbacks(execute=True):
        job = owner_client.post("/api/v1/exports/companies/", {}, format="json").json()
    resp = owner_client.get(f"/api/v1/exports/companies/{job['id']}/download/")
    assert resp.status_code == 200
    assert resp["Content-Type"] == "text/csv; charset=utf-8"
    assert resp["Cache-Control"] == "no-store"
    assert 'filename="companys-' in resp["Content-Disposition"] or 'filename="companies-' in resp["Content-Disposition"]
