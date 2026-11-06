"""Milestone 2 import/export: XLSX, deals, dedupe, dry-run preview, rollback (with conflicts and counter
correction), a clean stop at the plan's record limit, migration presets, and the full export."""

from __future__ import annotations

import csv
import io
import zipfile

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.audit.models import AuditEvent
from apps.contacts.models import Contact
from apps.deals.models import Deal
from tests.m2_helpers import in_org, manager_and_reps, restrict, set_plan, set_usage, usage

pytestmark = pytest.mark.django_db


def _csv(header: list[str], rows: list[list[str]]) -> bytes:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(header)
    w.writerows(rows)
    return out.getvalue().encode()


def _upload(client, entity, content, name="data.csv"):
    file = SimpleUploadedFile(name, content, content_type="application/octet-stream")
    resp = client.post(f"/api/v1/imports/{entity}/", {"file": file}, format="multipart")
    assert resp.status_code == 201, resp.content
    return resp.json()


def _run(client, entity, job_id, action, capture, body=None):
    with capture(execute=True):
        resp = client.post(f"/api/v1/imports/{entity}/{job_id}/{action}/", body or {}, format="json")
    assert resp.status_code == 202, resp.content
    return client.get(f"/api/v1/imports/{entity}/{job_id}/").json()


def test_xlsx_upload_is_converted(org_a, owner_client, django_capture_on_commit_callbacks):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["First name", "Email", "Joined"])
    ws.append(["Ada", "ada@example.com", __import__("datetime").date(2026, 1, 5)])
    ws.append(["Grace", "grace@example.com", None])
    buf = io.BytesIO()
    wb.save(buf)
    job = _upload(owner_client, "contacts", buf.getvalue(), name="people.xlsx")
    assert job["file_format"] == "xlsx" and job["total_rows"] == 2
    assert job["sample"][0]["Joined"] == "2026-01-05"
    done = _run(
        owner_client,
        "contacts",
        job["id"],
        "start",
        django_capture_on_commit_callbacks,
        {"mapping": {"First name": "first_name", "Email": "email"}},
    )
    assert done["status"] == "completed" and done["created_rows"] == 2
    bad = SimpleUploadedFile("broken.xlsx", b"PK\x03\x04 not really", content_type="application/octet-stream")
    assert owner_client.post("/api/v1/imports/contacts/", {"file": bad}, format="multipart").status_code == 400


def test_deal_import_with_pipeline_stage_company_and_contact(
    org_a, owner_client, crm, django_capture_on_commit_callbacks
):
    crm.make_contact(org_a, email="buyer@acme.test")
    content = _csv(
        ["Deal Name", "Amount", "Closing Date", "Stage", "Account Name", "Contact Name"],
        [
            ["Acme rollout", "12000", "2026-12-01", "Proposal sent", "Acme", "buyer@acme.test"],
            ["Bad stage", "1", "", "Nowhere", "", ""],
        ],
    )
    job = _upload(owner_client, "deals", content)
    preset = owner_client.post(
        f"/api/v1/imports/deals/{job['id']}/suggest/", {"preset": "zoho_crm"}, format="json"
    ).json()
    assert preset["mapping"]["Deal Name"] == "name" and preset["mapping"]["Account Name"] == "company"
    done = _run(
        owner_client, "deals", job["id"], "start", django_capture_on_commit_callbacks, {"mapping": preset["mapping"]}
    )
    assert done["created_rows"] == 1 and done["error_rows"] == 1, done
    assert done["errors"][0]["errors"][0]["field"] == "stage"
    with in_org(org_a):
        deal = Deal.objects.select_related("stage", "company", "primary_contact").get(name="Acme rollout")
        assert deal.stage.name == "Proposal sent" and deal.amount == 12000
        assert deal.company.name == "Acme" and deal.primary_contact.email == "buyer@acme.test"
        assert str(deal.expected_close_date) == "2026-12-01"


def test_dedupe_skip_and_update(org_a, owner_client, crm, django_capture_on_commit_callbacks):
    existing = crm.make_contact(org_a, first_name="Ada", email="ada@example.com", job_title="Engineer")
    content = _csv(
        ["First name", "Email", "Title"], [["Ada", "ADA@example.com", "CTO"], ["Grace", "grace@example.com", "CEO"]]
    )
    mapping = {"First name": "first_name", "Email": "email", "Title": "job_title"}

    job = _upload(owner_client, "contacts", content)
    skipped = _run(
        owner_client,
        "contacts",
        job["id"],
        "start",
        django_capture_on_commit_callbacks,
        {"mapping": mapping, "options": {"dedupe": "skip"}},
    )
    assert (skipped["created_rows"], skipped["skipped_rows"], skipped["updated_rows"]) == (1, 1, 0)

    job2 = _upload(owner_client, "contacts", content)
    updated = _run(
        owner_client,
        "contacts",
        job2["id"],
        "start",
        django_capture_on_commit_callbacks,
        {"mapping": mapping, "options": {"dedupe": "update"}},
    )
    assert (updated["created_rows"], updated["updated_rows"]) == (0, 2), updated
    with in_org(org_a):
        assert Contact.objects.get(pk=existing.pk).job_title == "CTO"
        assert Contact.objects.filter(email__iexact="grace@example.com").count() == 1


def test_preview_commit_and_full_rollback_of_5000_rows(
    org_a, owner_client, crm, settings, django_capture_on_commit_callbacks
):
    """Acceptance: 5,000 rows preview, commit, then fully roll back with counters correct and conflicts reported."""
    settings.IMPORT_BATCH_SIZE = 500
    edited_target = crm.make_contact(org_a, first_name="Keep", email="row00010@example.com", job_title="Original")
    rows = [[f"Row{i:05d}", f"row{i:05d}@example.com", "Imported"] for i in range(5000)]
    rows.append(["Broken", "not-an-email", ""])
    job = _upload(owner_client, "contacts", _csv(["First name", "Email", "Title"], rows))
    mapping = {"First name": "first_name", "Email": "email", "Title": "job_title"}
    before = usage(org_a)

    checked = _run(
        owner_client,
        "contacts",
        job["id"],
        "check",
        django_capture_on_commit_callbacks,
        {"mapping": mapping, "options": {"dedupe": "update"}},
    )
    assert checked["status"] == "previewed"
    pv = checked["preview"]
    assert (pv["would_create"], pv["would_update"], pv["would_fail"]) == (4999, 1, 1)
    assert pv["errors"][0]["row"] == 5001 and pv["limit"] is None
    with in_org(org_a):
        assert Contact.objects.count() == 1  # the dry run wrote nothing

    done = _run(owner_client, "contacts", job["id"], "start", django_capture_on_commit_callbacks)
    assert done["status"] == "completed" and done["created_rows"] == 4999 and done["updated_rows"] == 1
    assert usage(org_a) == before + 4999

    # someone edits one imported record and adds a note to another before the rollback
    with in_org(org_a):
        touched = Contact.objects.get(email="row00042@example.com")
        noted = Contact.objects.get(email="row00043@example.com")
    owner_client.patch(
        f"/api/v1/contacts/{touched.pk}/", {"job_title": "Changed by Bob", "version": touched.version}, format="json"
    )
    owner_client.post(
        "/api/v1/notes/", {"entity_type": "contact", "entity_id": str(noted.pk), "body": "keep me"}, format="json"
    )

    rolled = _run(owner_client, "contacts", job["id"], "rollback", django_capture_on_commit_callbacks)
    assert rolled["status"] == "rolled_back", rolled
    summary = rolled["rollback"]
    assert summary["deleted"] == 4997 and summary["reverted"] == 1 and summary["conflict_count"] == 2
    reasons = {c["entity_id"]: c["reason"] for c in summary["conflicts"]}
    assert reasons[str(touched.pk)] == "changed_since_import" and reasons[str(noted.pk)] == "has_notes"
    assert usage(org_a) == before + 2  # the two kept records still hold their slots
    with in_org(org_a):
        assert Contact.objects.get(pk=edited_target.pk).job_title == "Original"  # update reverted
        assert Contact.objects.get(pk=touched.pk).job_title == "Changed by Bob"  # not overwritten
        assert Contact.objects.count() == 3
        assert AuditEvent.objects.filter(action="imports.rolled_back").count() == 4998
        assert AuditEvent.objects.filter(action="imports.rollback_completed").exists()
    again = owner_client.post(f"/api/v1/imports/contacts/{job['id']}/rollback/")
    assert again.status_code == 409


def test_import_stops_cleanly_at_the_record_limit(org_a, owner_client, django_capture_on_commit_callbacks, settings):
    """Acceptance: an import crossing the record limit stops cleanly and names what lifts it."""
    settings.IMPORT_BATCH_SIZE = 4
    set_plan(org_a, "free")
    set_usage(org_a, "records", 495)  # room for 5 more
    rows = [[f"P{i}", f"p{i}@example.com"] for i in range(10)]
    job = _upload(owner_client, "contacts", _csv(["First name", "Email"], rows))
    mapping = {"First name": "first_name", "Email": "email"}
    checked = _run(
        owner_client, "contacts", job["id"], "check", django_capture_on_commit_callbacks, {"mapping": mapping}
    )
    assert checked["preview"]["limit"]["stops_at_row"] == 6
    assert checked["preview"]["limit"]["upgrade"]["required_edition"]["key"] == "express"
    done = _run(owner_client, "contacts", job["id"], "start", django_capture_on_commit_callbacks)
    assert done["status"] == "stopped" and done["created_rows"] == 5 and done["processed_rows"] == 5
    assert done["stop"]["row"] == 6 and done["stop"]["upgrade"]["metric"] == "records"
    assert done["stop"]["upgrade"]["addon"] in (None, "extra_records")
    assert usage(org_a) == 500
    with in_org(org_a):
        assert Contact.objects.count() == 5
        assert AuditEvent.objects.filter(action="imports.stopped_at_limit").exists()
    # the rollback gives the slots back, so the plan has room again
    rolled = _run(owner_client, "contacts", job["id"], "rollback", django_capture_on_commit_callbacks)
    assert rolled["rollback"]["deleted"] == 5 and usage(org_a) == 495
    assert owner_client.post("/api/v1/contacts/", {"first_name": "After"}, format="json").status_code == 201


def test_record_limit_addon_lifts_an_import(org_a, owner_client, django_capture_on_commit_callbacks):
    set_plan(org_a, "express", seats=1)
    set_usage(org_a, "records", 50_000)
    job = _upload(owner_client, "contacts", _csv(["Email"], [["a@example.com"]]))
    blocked = _run(
        owner_client,
        "contacts",
        job["id"],
        "start",
        django_capture_on_commit_callbacks,
        {"mapping": {"Email": "email"}},
    )
    assert blocked["status"] == "stopped"
    assert owner_client.post("/api/v1/billing/addons/", {"addon": "extra_records"}, format="json").status_code == 201
    job2 = _upload(owner_client, "contacts", _csv(["Email"], [["a@example.com"]]))
    ok = _run(
        owner_client,
        "contacts",
        job2["id"],
        "start",
        django_capture_on_commit_callbacks,
        {"mapping": {"Email": "email"}},
    )
    assert ok["status"] == "completed" and ok["created_rows"] == 1


def test_hidden_and_read_only_fields_are_not_import_targets(org_a, owner_client, make_member, client_for):
    mgr = make_member(org_a, "sales_manager")
    restrict(
        owner_client,
        "sales_manager",
        "contact",
        [{"field": "phone", "access": "hidden"}, {"field": "email", "access": "read_only"}],
    )
    client = client_for(mgr.user, mgr)
    job = _upload(client, "contacts", _csv(["First name", "Phone", "Email"], [["Ada", "1", "a@x.com"]]))
    assert "phone" not in job["targets"] and "email" not in job["targets"]
    assert "Phone" not in job["mapping"] and "Email" not in job["mapping"]
    resp = client.post(f"/api/v1/imports/contacts/{job['id']}/start/", {"mapping": {"Phone": "phone"}}, format="json")
    assert resp.status_code == 400


def test_presets_are_listed(owner_client):
    presets = owner_client.get("/api/v1/imports/contacts/presets/").json()["results"]
    assert {p["key"] for p in presets} == {"zoho_crm", "hubspot", "pipedrive"}


def test_full_export_obeys_hierarchy_and_field_rules(
    org_a, owner_client, make_member, client_for, crm, reauthenticate, django_capture_on_commit_callbacks
):
    manager, rep1, _rep2, outsider = manager_and_reps(org_a, owner_client, make_member)
    for m, name in [(manager, "Mgr"), (rep1, "Rep1"), (outsider, "Out")]:
        crm.make_contact(org_a, owner=m, first_name=name, phone="+1555000")
        crm.make_deal(org_a, owner=m, name=f"{name} deal")
    from apps.authz.models import Role

    with in_org(org_a):
        key = Role.objects.get(pk=manager.role_id).key
    restrict(owner_client, key, "contact", [{"field": "phone", "access": "hidden"}])
    client = client_for(manager.user, manager)
    reauthenticate(client)
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.post("/api/v1/exports/all/", {}, format="json")
    assert resp.status_code == 202, resp.content
    job = client.get(f"/api/v1/exports/all/{resp.json()['id']}/").json()
    assert job["status"] == "completed", job
    download = client.get(f"/api/v1/exports/all/{job['id']}/download/")
    assert download["Content-Type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(download.content)) as zf:
        names = set(zf.namelist())
        assert names == {"contacts.csv", "deals.csv"}  # the profile may export these two modules only
        contacts = list(csv.reader(io.StringIO(zf.read("contacts.csv").decode("utf-8-sig"))))
        deals = list(csv.reader(io.StringIO(zf.read("deals.csv").decode("utf-8-sig"))))
    assert "Phone" not in contacts[0]
    first = contacts[0].index("First name")
    assert {r[first] for r in contacts[1:]} == {"Mgr", "Rep1"}
    assert {r[deals[0].index("Name")] for r in deals[1:]} == {"Mgr deal", "Rep1 deal"}


def test_import_jobs_are_tenant_isolated(org_a, org_b, owner_client, client_for):
    job = _upload(owner_client, "contacts", _csv(["Email"], [["a@example.com"]]))
    other = client_for(org_b.owner, org_b.owner_membership)
    for action in ("check", "start", "rollback", "suggest"):
        assert other.post(f"/api/v1/imports/contacts/{job['id']}/{action}/", {}, format="json").status_code == 404


def test_usage_page_breaks_records_down_by_module(org_a, owner_client, crm):
    crm.make_contact(org_a)
    crm.make_deal(org_a)
    report = owner_client.get("/api/v1/billing/usage/").json()
    records = next(m for m in report["metrics"] if m["key"] == "records")
    by_module = {m["module"]: m["used"] for m in records["modules"]}
    assert by_module["contact"] == 1 and by_module["deal"] == 1 and by_module["company"] == 0
    assert "Activities" in report["record_definition"]
