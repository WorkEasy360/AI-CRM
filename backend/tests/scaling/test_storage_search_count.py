"""Object storage backend, index-friendly search and bounded counts."""

from __future__ import annotations

import uuid

import pytest

from apps.importexport import storage
from apps.search.service import prefix_tsquery

pytestmark = pytest.mark.security


class FakeS3:
    def __init__(self):
        self.objects: dict[tuple[str, str], bytes] = {}
        self.calls: list[tuple] = []

    def put_object(self, *, Bucket, Key, Body, ContentType, **kwargs):
        self.calls.append(("put", kwargs))
        self.objects[(Bucket, Key)] = Body

    def get_object(self, *, Bucket, Key):
        import io

        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}

    def head_object(self, *, Bucket, Key):
        from botocore.exceptions import ClientError

        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {}

    def delete_object(self, *, Bucket, Key):
        self.objects.pop((Bucket, Key), None)

    def generate_presigned_url(self, op, *, Params, ExpiresIn):
        self.calls.append(("sign", Params, ExpiresIn))
        return f"https://{Params['Bucket']}.s3.example/{Params['Key']}?sig=x&exp={ExpiresIn}"


@pytest.fixture
def s3(settings, monkeypatch):
    settings.PRIVATE_STORAGE_BACKEND = "s3"
    settings.PRIVATE_STORAGE_BUCKET = "keel-private-test"
    settings.PRIVATE_STORAGE_URL_TTL_SECONDS = 60
    storage.reset_backend_cache()
    fake = FakeS3()
    monkeypatch.setattr(storage.S3Backend, "client", lambda self: fake)
    yield fake
    storage.reset_backend_cache()


def test_s3_backend_round_trip_encrypts_and_validates_keys(s3):
    org = uuid.uuid4()
    key = storage.new_key(org, "exports")
    assert storage.write(key, b"a,b\r\n") == 5
    assert s3.calls[0][1]["ServerSideEncryption"] == "aws:kms"
    assert storage.exists(key) and storage.read(key) == b"a,b\r\n"
    assert storage.organization_of(key) == org
    storage.delete(key)
    assert not storage.exists(key)
    for bad in ("../../etc/passwd", f"{org}/exports/../x.csv", f"{org}/other/{'a' * 32}.csv", "x"):
        with pytest.raises(ValueError):
            storage.write(bad, b"x")
        assert storage.exists(bad) is False


def test_only_temporary_objects_are_tagged_for_lifecycle_expiry(s3):
    """The bucket's 7-day expiry matches the tag, so a permanent attachment must never carry it."""
    org = uuid.uuid4()
    for kind in ("imports", "exports"):
        storage.write(storage.new_key(org, kind), b"a,b\r\n")
    for kind in ("files", "email"):
        storage.write(storage.new_key(org, kind), b"%PDF", "application/pdf")
    tagging = [call[1].get("Tagging") for call in s3.calls if call[0] == "put"]
    assert tagging == ["retention=temporary", "retention=temporary", None, None]


def test_signed_url_is_short_lived_and_forces_attachment(s3):
    key = storage.new_key(uuid.uuid4(), "exports")
    url = storage.signed_download_url(key, 'weird "name"; .csv')
    assert url.startswith("https://") and "exp=60" in url
    _, params, expires = next(c for c in s3.calls if c[0] == "sign")
    assert expires == 60
    assert params["ResponseContentDisposition"].startswith("attachment;")
    assert '"' not in params["ResponseContentDisposition"].split("filename=")[1].strip('"')
    assert params["ResponseCacheControl"] == "no-store"


@pytest.mark.django_db
def test_download_redirects_to_signed_url_and_is_audited(s3, org_a, org_b, crm, client_for, reauthenticate):
    from apps.core.tenancy.context import tenant_context
    from apps.importexport.models import ExportJob, JobStatus

    job = crm.make_export_job(org_a)
    key = storage.new_key(org_a.org.pk, "exports")
    storage.write(key, b"x")
    with tenant_context(org_a.org.pk, reason="test"):
        ExportJob.objects.filter(pk=job.pk).update(status=JobStatus.COMPLETED, storage_key=key, row_count=1)
    client = client_for(org_a.owner, org_a.owner_membership)
    reauthenticate(client)
    resp = client.get(f"/api/v1/exports/contacts/{job.pk}/download/")
    assert resp.status_code == 302
    assert resp["Location"].startswith("https://keel-private-test.s3.example/")
    assert resp["Cache-Control"] == "no-store"
    # Another organization never learns the URL, not even that the job exists.
    other = client_for(org_b.owner, org_b.owner_membership)
    reauthenticate(other)
    assert other.get(f"/api/v1/exports/contacts/{job.pk}/download/").status_code == 404
    from apps.audit.models import AuditEvent

    with tenant_context(org_a.org.pk, reason="test"):
        assert AuditEvent.objects.filter(action="exports.downloaded", resource_id=job.pk).exists()


def test_prefix_tsquery_is_index_friendly_and_injection_safe():
    assert prefix_tsquery("Jo") == "jo:*"
    assert prefix_tsquery("john smith") == "john & smith:*"
    assert prefix_tsquery("john@example.com") == "john & example & com:*"
    assert prefix_tsquery("a) | (b & !c") == "a & b & c:*"
    assert prefix_tsquery("   ") is None
    assert prefix_tsquery("x " * 20).count("&") == 7  # capped at MAX_TERMS


@pytest.mark.django_db
def test_search_finds_prefixes_and_emails_within_scope(org_a, org_b, crm, owner_client):
    crm.make_contact(org_a, first_name="Ada", last_name="Lovelace", email="ada@analytical.example")
    crm.make_contact(org_b, first_name="Adam", last_name="Other")
    for q, expected in (("ada", 1), ("Lovel", 1), ("analytical", 1), ("ada lovel", 1), ("zzz", 0)):
        resp = owner_client.get("/api/v1/search/", {"q": q, "types": "contact"})
        assert resp.status_code == 200, resp.content
        assert len(resp.json()["results"]["contact"]) == expected, q
    # Org B's "Adam" never appears for org A even though "ada" is a prefix of it.
    titles = [r["title"] for r in owner_client.get("/api/v1/search/", {"q": "ada"}).json()["results"]["contact"]]
    assert titles == ["Ada Lovelace"]


@pytest.mark.django_db
def test_count_is_bounded(org_a, crm, owner_client, settings):
    settings.LIST_COUNT_CAP = 2
    for _ in range(3):
        crm.make_contact(org_a)
    assert owner_client.get("/api/v1/contacts/count/").json() == {"count": 2, "exact": False}
    settings.LIST_COUNT_CAP = 10
    assert owner_client.get("/api/v1/contacts/count/").json() == {"count": 3, "exact": True}


@pytest.mark.django_db
def test_session_is_valid_on_any_instance(org_a, client_for, settings):
    """Sessions live in the database (cached in Redis); a cookie minted by one process must authenticate
    on a fresh process with no shared memory. A brand-new client with only the cookie stands in for that."""
    from rest_framework.test import APIClient

    first = client_for(org_a.owner, org_a.owner_membership)
    assert first.get("/api/v1/session/").status_code == 200
    cookie = first.cookies[settings.SESSION_COOKIE_NAME].value
    second = APIClient()
    second.cookies[settings.SESSION_COOKIE_NAME] = cookie
    resp = second.get("/api/v1/session/")
    assert resp.status_code == 200
    assert resp.json()["active"]["organization"]["id"] == str(org_a.org.pk)
