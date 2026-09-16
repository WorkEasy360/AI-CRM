"""Files hang off records the actor can view; bytes live in private storage, never in MEDIA."""

from __future__ import annotations

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from apps.core.tenancy.context import tenant_context
from apps.files.models import FileAttachment
from apps.importexport import storage

pytestmark = pytest.mark.django_db

PDF = b"%PDF-1.4 fake"


@pytest.fixture(autouse=True)
def _private_root(settings, tmp_path):
    settings.PRIVATE_STORAGE_BACKEND = "filesystem"
    settings.PRIVATE_STORAGE_ROOT = str(tmp_path / "private")
    storage.reset_backend_cache()
    yield
    storage.reset_backend_cache()


def _upload(client, entity_type, entity_id, *, name="brief.pdf", content=PDF, content_type="application/pdf"):
    return client.post(
        "/api/v1/files/",
        {
            "entity_type": entity_type,
            "entity_id": str(entity_id),
            "file": SimpleUploadedFile(name, content, content_type=content_type),
        },
        format="multipart",
    )


def test_upload_list_download_and_record_visibility(org_a, crm, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    manager = make_member(org_a, "sales_manager")
    deal = crm.make_deal(org_a, owner=rep)
    hidden = crm.make_contact(org_a, owner=manager)
    repc = client_for(rep.user, rep)

    resp = _upload(repc, "deal", deal.pk)
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["filename"] == "brief.pdf"
    assert body["size_bytes"] == len(PDF)
    assert body["uploaded_by"]["id"] == str(rep.pk)

    listed = repc.get(f"/api/v1/files/?entity_type=deal&entity_id={deal.pk}").json()["results"]
    assert [f["id"] for f in listed] == [body["id"]]

    download = repc.get(f"/api/v1/files/{body['id']}/download/")
    assert download.status_code == 200
    assert download.getvalue() == PDF
    assert download["Content-Disposition"] == 'attachment; filename="brief.pdf"'
    assert download["X-Content-Type-Options"] == "nosniff"
    assert download["Cache-Control"] == "no-store"

    # the key is server-generated and scoped to the organization; nothing of the client's reaches the path
    with tenant_context(org_a.org.pk):
        attachment = FileAttachment.objects.get(pk=body["id"])
    assert attachment.storage_key.startswith(f"{org_a.org.pk}/files/")
    assert storage.organization_of(attachment.storage_key) == org_a.org.pk

    # a record outside the view scope is a 404, never a 403 (no existence leak)
    assert _upload(repc, "contact", hidden.pk).status_code == 404
    assert repc.get(f"/api/v1/files/?entity_type=contact&entity_id={hidden.pk}").status_code == 404


def test_upload_rejects_disallowed_types_and_empty_files(org_a, crm, owner_client):
    deal = crm.make_deal(org_a)
    svg = _upload(owner_client, "deal", deal.pk, name="x.svg", content=b"<svg/>", content_type="image/svg+xml")
    html = _upload(owner_client, "deal", deal.pk, name="x.html", content=b"<h1>", content_type="text/html")
    assert svg.status_code == 400 and html.status_code == 400
    assert _upload(owner_client, "deal", deal.pk, content=b"").status_code == 400
    # Django strips the directory part of an uploaded name; the sanitiser handles whatever is left
    assert _upload(owner_client, "deal", deal.pk, name="../../etc/pass wd", content=PDF).json()["filename"] == "pass wd"
    with tenant_context(org_a.org.pk):
        assert not FileAttachment.objects.filter(filename__contains="..").exists()


def test_delete_scope_and_blob_removal(
    org_a, crm, make_member, client_for, owner_client, django_capture_on_commit_callbacks
):
    rep = make_member(org_a, "sales_rep")
    other_rep = make_member(org_a, "sales_rep")
    deal = crm.make_deal(org_a, owner=rep)
    repc = client_for(rep.user, rep)
    uploaded = _upload(repc, "deal", deal.pk).json()
    with tenant_context(org_a.org.pk):
        key = FileAttachment.objects.get(pk=uploaded["id"]).storage_key

    # a rep with no sight of the deal cannot reach the file at all
    assert client_for(other_rep.user, other_rep).delete(f"/api/v1/files/{uploaded['id']}/").status_code == 404
    with django_capture_on_commit_callbacks(execute=True):  # the blob drops only once the row is really gone
        assert repc.delete(f"/api/v1/files/{uploaded['id']}/").status_code == 204
    with tenant_context(org_a.org.pk):
        assert not FileAttachment.objects.filter(pk=uploaded["id"]).exists()
    assert not storage.exists(key)

    # the owner may remove someone else's upload
    again = _upload(repc, "deal", deal.pk).json()
    assert owner_client.delete(f"/api/v1/files/{again['id']}/").status_code == 204


def test_viewer_may_read_but_not_upload(org_a, crm, make_member, client_for, owner_client):
    viewer = make_member(org_a, "viewer")
    deal = crm.make_deal(org_a)
    uploaded = _upload(owner_client, "deal", deal.pk).json()
    viewerc = client_for(viewer.user, viewer)
    assert viewerc.get(f"/api/v1/files/?entity_type=deal&entity_id={deal.pk}").status_code == 200
    assert viewerc.get(f"/api/v1/files/{uploaded['id']}/download/").status_code == 200
    assert _upload(viewerc, "deal", deal.pk).status_code == 403
    assert viewerc.delete(f"/api/v1/files/{uploaded['id']}/").status_code == 403
