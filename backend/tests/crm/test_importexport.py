"""CSV import/export: upload hardening, mapping validation, background processing, scoped export,
formula neutralisation, requester-only downloads."""

from __future__ import annotations

import io

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.audit.models import AuditEvent
from apps.contacts.models import Contact
from apps.core.tenancy.context import tenant_context
from apps.importexport import csvsafe

pytestmark = pytest.mark.django_db


def _upload(client, entity="contacts", content=b"", name="people.csv"):
    file = SimpleUploadedFile(name, content, content_type="text/csv")
    return client.post(f"/api/v1/imports/{entity}/", {"file": file}, format="multipart")


CSV = (
    b"\xef\xbb\xbfFirst name,Last Name,E-mail,Company,Priority\r\n"
    b"Ada,Lovelace,ada@example.com,Analytical Engines,high\r\n"
    b"Bad,Row,not-an-email,,low\r\n"
    b"=cmd|' /C calc'!A0,Evil,evil@example.com,Analytical Engines,high\r\n"
)


def test_upload_validation(org_a, owner_client):
    assert _upload(owner_client, content=b"a,b\n1,2\n", name="x.xlsx").status_code == 400
    assert _upload(owner_client, content=b"").status_code == 400
    assert _upload(owner_client, content=b"a,b\n1,\x00\n").status_code == 400
    assert _upload(owner_client, content=b"a,b\n1,\xff\xfe\n").status_code == 400
    assert _upload(owner_client, content=b"a,b\n").status_code == 400  # no data rows
    assert _upload(owner_client, content=b"a,a\n1,2\n").status_code == 400  # duplicate headers
    assert _upload(owner_client, content=b"a,b\n1,2,3\n").status_code == 400  # ragged row
    too_wide = ",".join(f"c{i}" for i in range(61)).encode() + b"\n" + b",".join(b"1" for _ in range(61)) + b"\n"
    assert _upload(owner_client, content=too_wide).status_code == 400
    too_long = b"a\n" + b"x\n" * (csvsafe.MAX_ROWS + 1)
    assert _upload(owner_client, content=too_long).status_code == 400
    big_cell = b"a\n" + b"x" * (csvsafe.MAX_CELL_LENGTH + 1) + b"\n"
    assert _upload(owner_client, content=big_cell).status_code == 400
    huge = b"a\n" + b"x," * (csvsafe.MAX_UPLOAD_BYTES // 2 + 10)
    assert _upload(owner_client, content=huge).status_code == 400
    # wrong field name / JSON instead of multipart
    assert owner_client.post("/api/v1/imports/contacts/", {"file": "x"}, format="json").status_code in (400, 415)


def test_import_end_to_end(org_a, owner_client, crm, django_capture_on_commit_callbacks):
    crm.make_custom_field(
        org_a, "contact", "priority", field_type="dropdown", options=["low", "high"], label="Priority"
    )
    resp = _upload(owner_client, content=CSV)
    assert resp.status_code == 201, resp.content
    job = resp.json()
    assert job["status"] == "uploaded" and job["total_rows"] == 3
    assert job["headers"] == ["First name", "Last Name", "E-mail", "Company", "Priority"]
    assert job["mapping"] == {
        "First name": "first_name",
        "Last Name": "last_name",
        "E-mail": "email",
        "Company": "company_name",
        "Priority": "custom.priority",
    }
    assert job["preview"][2]["First name"].startswith("'=")  # preview cells are neutralised
    assert "custom.priority" in job["targets"] and "owner_id" not in job["targets"]
    # mapping validation
    jid = job["id"]
    assert (
        owner_client.post(
            f"/api/v1/imports/contacts/{jid}/start/", {"mapping": {"E-mail": "owner_id"}}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.post(
            f"/api/v1/imports/contacts/{jid}/start/", {"mapping": {"Nope": "email"}}, format="json"
        ).status_code
        == 400
    )
    assert (
        owner_client.post(
            f"/api/v1/imports/contacts/{jid}/start/",
            {"mapping": {"E-mail": "email", "Company": "email"}},
            format="json",
        ).status_code
        == 400
    )
    assert (
        owner_client.post(f"/api/v1/imports/contacts/{jid}/start/", {"mapping": {}}, format="json").status_code == 400
    )
    # start (runs eagerly in tests)
    with django_capture_on_commit_callbacks(execute=True):
        resp = owner_client.post(f"/api/v1/imports/contacts/{jid}/start/", {"mapping": job["mapping"]}, format="json")
    assert resp.status_code == 202, resp.content
    result = owner_client.get(f"/api/v1/imports/contacts/{jid}/").json()
    assert result["status"] == "completed", result
    assert result["processed_rows"] == 3 and result["created_rows"] == 2 and result["error_rows"] == 1
    assert result["errors"][0]["row"] == 2 and result["errors"][0]["errors"][0]["field"] == "email"
    assert (
        owner_client.post(
            f"/api/v1/imports/contacts/{jid}/start/", {"mapping": job["mapping"]}, format="json"
        ).status_code
        == 409
    )
    with tenant_context(org_a.org.pk):
        ada = Contact.objects.get(email="ada@example.com")
        assert ada.company.name == "Analytical Engines" and ada.custom_data == {"priority": "high"}
        assert ada.owner_id == org_a.owner_membership.pk
        assert Contact.objects.filter(email="evil@example.com").exists()  # stored verbatim, neutralised on export
        assert AuditEvent.objects.filter(action="imports.completed").exists()
        assert AuditEvent.objects.filter(action="contacts.created", metadata__import_job_id=str(jid)).count() == 2


def test_import_permissions(org_a, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    manager = make_member(org_a, "sales_manager")
    assert _upload(client_for(rep.user, rep), content=CSV).status_code == 403
    assert _upload(client_for(manager.user, manager), content=CSV).status_code == 201
    assert _upload(client_for(manager.user, manager), entity="products", content=b"name\nx\n").status_code == 403
    assert client_for(rep.user, rep).get("/api/v1/imports/contacts/").status_code == 403


def test_export_is_scoped_neutralised_and_requester_only(
    org_a, org_b, crm, make_member, client_for, reauthenticate, django_capture_on_commit_callbacks
):
    manager = make_member(org_a, "sales_manager")
    crm.make_contact(org_a, first_name='=HYPERLINK("http://evil")', last_name="Cell", email="e@x.io")
    crm.make_contact(org_a, first_name="+1", last_name="Plus")
    crm.make_contact(org_a, first_name="Archived", last_name="Gone", archived_at="2026-01-01T00:00:00Z")
    crm.make_contact(org_b, first_name="Foreign", last_name="Tenant")
    mgr = client_for(manager.user, manager)
    # recent authentication is required for exports
    assert mgr.post("/api/v1/exports/contacts/", {}, format="json").status_code == 403
    reauthenticate(mgr)
    with django_capture_on_commit_callbacks(execute=True):
        resp = mgr.post("/api/v1/exports/contacts/", {"filters": {"sort": "name"}}, format="json")
    assert resp.status_code == 202, resp.content
    job = resp.json()
    assert mgr.post("/api/v1/exports/contacts/", {"filters": {"evil": "1"}}, format="json").status_code == 400
    detail = mgr.get(f"/api/v1/exports/contacts/{job['id']}/").json()
    assert detail["status"] == "completed" and detail["row_count"] == 2
    resp = mgr.get(f"/api/v1/exports/contacts/{job['id']}/download/")
    assert resp.status_code == 200
    assert resp["Content-Disposition"].startswith("attachment;") and resp["X-Content-Type-Options"] == "nosniff"
    text = resp.content.decode("utf-8-sig")
    assert "Foreign" not in text and "Archived" not in text
    rows = list(__import__("csv").reader(io.StringIO(text)))
    first_names = {r[1] for r in rows[1:]}
    assert '\'=HYPERLINK("http://evil")' in first_names and "'+1" in first_names
    # another member (even the owner) cannot download someone else's export
    owner = client_for(org_a.owner, org_a.owner_membership)
    assert owner.get(f"/api/v1/exports/contacts/{job['id']}/download/").status_code == 404
    assert owner.get(f"/api/v1/exports/contacts/{job['id']}/").status_code == 404
    with tenant_context(org_a.org.pk):
        assert AuditEvent.objects.filter(action="exports.requested").exists()
        assert AuditEvent.objects.filter(action="exports.downloaded").exists()


def test_export_permissions(org_a, make_member, client_for, reauthenticate):
    rep = make_member(org_a, "sales_rep")
    viewer = make_member(org_a, "viewer")
    for m in (rep, viewer):
        c = client_for(m.user, m)
        reauthenticate(c)
        assert c.post("/api/v1/exports/contacts/", {}, format="json").status_code == 403
        assert c.post("/api/v1/exports/deals/", {}, format="json").status_code == 403
        assert c.get("/api/v1/exports/contacts/").status_code == 403
    manager = make_member(org_a, "sales_manager")
    c = client_for(manager.user, manager)
    reauthenticate(c)
    assert c.post("/api/v1/exports/products/", {}, format="json").status_code == 403  # products.export is admin-only


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("=1+1", "'=1+1"),
        ("+SUM(A1)", "'+SUM(A1)"),
        ("-2+3", "'-2+3"),
        ("@cmd", "'@cmd"),
        ("\tx", "'\tx"),
        ("-5", "-5"),
        ("12.5", "12.5"),
        ("plain", "plain"),
        ("a|b", "'a|b"),
        ("", ""),
        (None, ""),
    ],
)
def test_neutralise(raw, expected):
    assert csvsafe.neutralise(raw) == expected
