"""Imports are partial, checkpointed and resumable -- and never silently inconsistent.

The contract under test:
  - one batch is one transaction; its rows and the progress that describes them commit together;
  - progress is visible while the job runs, not only at the end;
  - a job whose worker died resumes from its checkpoint and does not re-create committed rows;
  - a row that fails validation is reported and skipped, never fatal to the batch around it.
"""

from __future__ import annotations

import io

import pytest

from apps.contacts.models import Contact
from apps.core.tenancy.context import tenant_context
from apps.importexport import service
from apps.importexport.models import ImportJob, JobStatus
from apps.importexport.tasks import resume_stalled_imports, run_import

pytestmark = pytest.mark.django_db


def _csv(rows: int, *, bad_row: int | None = None) -> bytes:
    out = io.StringIO()
    out.write("first_name,last_name,email\n")
    for n in range(1, rows + 1):
        if n == bad_row:
            out.write(f"Bad{n},Row,not-an-email\n")  # fails the serializer, reported not fatal
        else:
            out.write(f"First{n},Last{n},person{n}@example.com\n")
    return out.getvalue().encode()


def _make_job(org, owner_client, rows: int, *, bad_row: int | None = None) -> ImportJob:
    """Upload a CSV and confirm the mapping, leaving the job PENDING for the test to drive."""
    from django.core.files.uploadedfile import SimpleUploadedFile

    upload = SimpleUploadedFile("people.csv", _csv(rows, bad_row=bad_row), content_type="text/csv")
    resp = owner_client.post("/api/v1/imports/contacts/", {"file": upload}, format="multipart")
    assert resp.status_code in (200, 201), resp.content
    job_id = resp.json()["id"]
    # Deliberately not wrapped in django_capture_on_commit_callbacks: the delivery task must NOT run
    # here, so each test can drive run_import itself and watch it batch.
    resp = owner_client.post(
        f"/api/v1/imports/contacts/{job_id}/start/",
        {"mapping": {"first_name": "first_name", "last_name": "last_name", "email": "email"}},
        format="json",
    )
    assert resp.status_code in (200, 202), resp.content
    with tenant_context(org.org.pk):
        return ImportJob.objects.get(pk=job_id)


def _reset_to_pending(org, job) -> ImportJob:
    with tenant_context(org.org.pk):
        ImportJob.objects.filter(pk=job.pk).update(
            status=JobStatus.PENDING,
            processed_rows=0,
            created_rows=0,
            error_rows=0,
            errors=[],
            checkpoint_row=0,
            attempts=0,
            finished_at=None,
        )
        return ImportJob.objects.get(pk=job.pk)


def _job(org, job_id) -> ImportJob:
    with tenant_context(org.org.pk):
        return ImportJob.objects.get(pk=job_id)


def _contacts(org) -> int:
    with tenant_context(org.org.pk):
        return Contact.objects.count()


# --------------------------------------------------------------------------- checkpointing


def test_progress_is_checkpointed_while_the_job_runs(org_a, owner_client, settings, monkeypatch):
    """The old design committed once at the end: the progress bar sat at zero, then jumped to done."""
    settings.IMPORT_BATCH_SIZE = 5
    job = _make_job(org_a, owner_client, rows=20)
    job = _reset_to_pending(org_a, job)

    seen: list[tuple[int, int]] = []
    original = service._run_batch

    def spy(*args, **kwargs):
        original(*args, **kwargs)
        # Read the row back in a *separate* transaction: this is what an API caller would see.
        row = _job(org_a, job.pk)
        seen.append((row.checkpoint_row, row.processed_rows))

    monkeypatch.setattr(service, "_run_batch", spy)
    run_import(
        job_id=str(job.pk),
        organization_id=str(org_a.org.pk),
        actor_membership_id=str(org_a.owner_membership.pk),
    )

    assert seen == [(5, 5), (10, 10), (15, 15), (20, 20)]
    final = _job(org_a, job.pk)
    assert final.status == JobStatus.COMPLETED
    assert final.created_rows == 20


def test_a_batch_commits_its_rows_and_its_checkpoint_together(org_a, owner_client, settings, monkeypatch):
    """The invariant that stops a resume double-creating: progress can never run ahead of the data."""
    settings.IMPORT_BATCH_SIZE = 5
    job = _make_job(org_a, owner_client, rows=20)
    job = _reset_to_pending(org_a, job)

    original = service._run_batch
    calls = {"n": 0}

    def fail_third(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("worker died mid-batch")
        return original(*args, **kwargs)

    monkeypatch.setattr(service, "_run_batch", fail_third)
    run_import(
        job_id=str(job.pk),
        organization_id=str(org_a.org.pk),
        actor_membership_id=str(org_a.owner_membership.pk),
    )

    row = _job(org_a, job.pk)
    # Two batches committed; the third rolled back entirely.
    assert row.checkpoint_row == 10
    assert row.created_rows == 10
    assert _contacts(org_a) == 10


# --------------------------------------------------------------------------- resume


def test_a_stalled_job_resumes_from_its_checkpoint_without_duplicating(org_a, owner_client, settings, monkeypatch):
    settings.IMPORT_BATCH_SIZE = 5
    job = _make_job(org_a, owner_client, rows=20)
    job = _reset_to_pending(org_a, job)

    original = service._run_batch
    calls = {"n": 0}

    def fail_third(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("worker died mid-batch")
        return original(*args, **kwargs)

    monkeypatch.setattr(service, "_run_batch", fail_third)
    assert (
        run_import(
            job_id=str(job.pk),
            organization_id=str(org_a.org.pk),
            actor_membership_id=str(org_a.owner_membership.pk),
        )
        == "interrupted"
    )
    assert _contacts(org_a) == 10
    # Interrupted, not failed: still RUNNING, so the sweeper will resume it.
    assert _job(org_a, job.pk).status == JobStatus.RUNNING
    monkeypatch.undo()

    run_import(
        job_id=str(job.pk),
        organization_id=str(org_a.org.pk),
        actor_membership_id=str(org_a.owner_membership.pk),
    )

    row = _job(org_a, job.pk)
    assert row.status == JobStatus.COMPLETED
    assert row.created_rows == 20
    assert _contacts(org_a) == 20  # the first ten were not imported a second time
    with tenant_context(org_a.org.pk):
        emails = list(Contact.objects.values_list("email", flat=True))
    assert len(emails) == len(set(emails))


def test_resume_gives_up_after_too_many_attempts(org_a, owner_client, settings):
    """A row that reliably kills the worker must not make the job immortal."""
    settings.IMPORT_MAX_ATTEMPTS = 2
    job = _make_job(org_a, owner_client, rows=5)
    with tenant_context(org_a.org.pk):
        ImportJob.objects.filter(pk=job.pk).update(status=JobStatus.RUNNING, attempts=2)

    result = run_import(
        job_id=str(job.pk),
        organization_id=str(org_a.org.pk),
        actor_membership_id=str(org_a.owner_membership.pk),
    )
    assert result == "failed"
    assert _job(org_a, job.pk).status == JobStatus.FAILED


def test_the_sweeper_only_picks_up_stalled_running_jobs(org_a, owner_client, settings):
    from django.utils import timezone

    job = _make_job(org_a, owner_client, rows=3)
    with tenant_context(org_a.org.pk):
        ImportJob.objects.filter(pk=job.pk).update(status=JobStatus.COMPLETED)
    assert resume_stalled_imports() == 0

    stale = timezone.now() - settings.IMPORT_RESUME_AFTER * 2
    with tenant_context(org_a.org.pk):
        ImportJob.objects.filter(pk=job.pk).update(status=JobStatus.RUNNING, updated_at=stale)
    assert resume_stalled_imports() == 1


# --------------------------------------------------------------------------- partial semantics


def test_a_bad_row_is_reported_and_the_rest_of_its_batch_still_commits(org_a, owner_client, settings):
    """Partial with explicit failure reporting: one invalid row does not discard its nineteen neighbours."""
    settings.IMPORT_BATCH_SIZE = 5
    job = _make_job(org_a, owner_client, rows=20, bad_row=7)
    job = _reset_to_pending(org_a, job)

    run_import(
        job_id=str(job.pk),
        organization_id=str(org_a.org.pk),
        actor_membership_id=str(org_a.owner_membership.pk),
    )

    row = _job(org_a, job.pk)
    assert row.status == JobStatus.COMPLETED
    assert row.processed_rows == 20
    assert row.created_rows == 19
    assert row.error_rows == 1
    assert [e["row"] for e in row.errors] == [7]
    assert _contacts(org_a) == 19


def test_a_failed_import_reports_how_far_it_got(org_a, owner_client, settings, monkeypatch):
    """Failure must be explicit, not silent: the job says what it committed before it stopped."""
    settings.IMPORT_BATCH_SIZE = 5
    settings.IMPORT_MAX_ATTEMPTS = 1  # the first interruption is already terminal
    job = _make_job(org_a, owner_client, rows=20)
    job = _reset_to_pending(org_a, job)

    original = service._run_batch
    calls = {"n": 0}

    def fail_second(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("provider exploded")
        return original(*args, **kwargs)

    monkeypatch.setattr(service, "_run_batch", fail_second)
    result = run_import(
        job_id=str(job.pk),
        organization_id=str(org_a.org.pk),
        actor_membership_id=str(org_a.owner_membership.pk),
    )

    assert result == "failed"
    row = _job(org_a, job.pk)
    assert row.status == JobStatus.FAILED
    assert row.error_message
    assert row.created_rows == 5 and row.checkpoint_row == 5  # explicit, not zero and not twenty


def test_import_stays_inside_its_tenant(org_a, org_b, owner_client, settings):
    settings.IMPORT_BATCH_SIZE = 2
    job = _make_job(org_a, owner_client, rows=4)
    job = _reset_to_pending(org_a, job)
    run_import(
        job_id=str(job.pk),
        organization_id=str(org_a.org.pk),
        actor_membership_id=str(org_a.owner_membership.pk),
    )
    assert _contacts(org_a) == 4
    with tenant_context(org_b.org.pk):
        assert Contact.objects.count() == 0
