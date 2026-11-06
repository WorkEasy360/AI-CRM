"""General settings: CRM name, date format and the workspace logo (who may change them, what is accepted)."""

from __future__ import annotations

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.audit.models import AuditEvent
from apps.core.tenancy.context import tenant_context

pytestmark = pytest.mark.django_db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
LOGO_URL = "/api/v1/organizations/current/logo/"


def _upload(client, blob: bytes, name: str = "logo.png", content_type: str = "image/png"):
    return client.post(
        LOGO_URL, {"file": SimpleUploadedFile(name, blob, content_type=content_type)}, format="multipart"
    )


def test_crm_name_and_date_format(org_a, owner_client, reauthenticate):
    reauthenticate(owner_client)
    resp = owner_client.patch(
        "/api/v1/organizations/current/", {"crm_name": "WorkEasy360 CRM", "date_format": "DD/MM/YYYY"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["crm_name"] == "WorkEasy360 CRM" and resp.json()["date_format"] == "DD/MM/YYYY"
    # the session carries them, so the shell can show the name and format dates
    org = owner_client.get("/api/v1/session/").json()["active"]["organization"]
    assert org["crm_name"] == "WorkEasy360 CRM" and org["date_format"] == "DD/MM/YYYY"
    assert owner_client.patch("/api/v1/organizations/current/", {"date_format": "%Y"}, format="json").status_code == 400
    assert (
        owner_client.patch("/api/v1/organizations/current/", {"crm_name": "x" * 61}, format="json").status_code == 400
    )


def test_logo_upload_serve_and_remove(org_a, org_b, owner_client, client_for, make_member, reauthenticate):
    assert _upload(owner_client, PNG).status_code == 403  # a sensitive change: recent sign-in first
    reauthenticate(owner_client)
    resp = _upload(owner_client, PNG)
    assert resp.status_code == 200, resp.content
    assert resp.json()["logo_url"].startswith(LOGO_URL)
    with tenant_context(org_a.org.pk):
        assert AuditEvent.objects.filter(action="org.updated", metadata__logo="updated").exists()

    # any member sees it, served as the sniffed type and never as something a browser would run
    viewer = make_member(org_a, "viewer")
    got = client_for(viewer.user, viewer).get(LOGO_URL)
    assert got.status_code == 200 and got.content == PNG
    assert got["Content-Type"] == "image/png" and got["X-Content-Type-Options"] == "nosniff"
    assert got["Content-Security-Policy"] == "default-src 'none'"
    # another organization has no logo, and cannot reach this one
    assert client_for(org_b.owner, org_b.owner_membership).get(LOGO_URL).status_code == 404
    # members without org.update cannot replace it
    assert _upload(client_for(viewer.user, viewer), PNG).status_code == 403

    assert owner_client.delete(LOGO_URL).status_code == 200
    assert owner_client.get(LOGO_URL).status_code == 404


def test_logo_must_be_a_small_raster_image(owner_client, reauthenticate):
    reauthenticate(owner_client)
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    assert _upload(owner_client, svg, "logo.svg", "image/svg+xml").status_code == 400
    assert _upload(owner_client, b"GIF89a....", "logo.png", "image/png").status_code == 400  # the bytes decide
    assert _upload(owner_client, PNG + b"\x00" * (512 * 1024)).status_code == 400
    assert owner_client.post(LOGO_URL, {}, format="multipart").status_code == 400
