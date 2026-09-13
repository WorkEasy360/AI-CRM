"""Queue isolation, tenant safety of background jobs, per-tenant fairness and email idempotency."""

from __future__ import annotations

import pytest
from django.core import mail

from apps.accounts.tasks import queue_email, send_email
from apps.core.exceptions import TenantContextMissing
from apps.importexport.models import JobStatus
from apps.importexport.tasks import EXPORT_TIME_LIMIT, IMPORT_TIME_LIMIT, run_export, run_import
from config.celery import app

pytestmark = pytest.mark.security


def test_heavy_tasks_are_routed_away_from_the_critical_queue(settings):
    routes = settings.CELERY_TASK_ROUTES
    assert routes["importexport.run_import"]["queue"] == "imports"
    assert routes["importexport.run_export"]["queue"] == "exports"
    assert routes["accounts.send_email"]["queue"] == "notifications"
    assert set(settings.CELERY_TASK_QUEUES) >= {"default", "imports", "exports", "notifications", "reports", "ai"}
    assert app.amqp.router.route({}, "importexport.run_import")["queue"].name == "imports"
    assert app.amqp.router.route({}, "accounts.send_email")["queue"].name == "notifications"
    assert app.amqp.router.route({}, "observability.publish_celery_metrics")["queue"].name == "default"


def test_task_time_limits_and_redelivery_settings(settings):
    assert run_import.time_limit == IMPORT_TIME_LIMIT and run_import.soft_time_limit < IMPORT_TIME_LIMIT
    assert run_export.time_limit == EXPORT_TIME_LIMIT
    assert settings.CELERY_BROKER_TRANSPORT_OPTIONS["visibility_timeout"] > IMPORT_TIME_LIMIT
    assert settings.CELERY_TASK_ACKS_LATE and settings.CELERY_TASK_REJECT_ON_WORKER_LOST
    assert send_email.max_retries == 3 and send_email.retry_jitter is True


def test_tenant_task_refuses_to_run_without_an_organization(db):
    with pytest.raises(TenantContextMissing):
        run_export.apply(kwargs={"job_id": "x", "actor_membership_id": "y"}).get()


@pytest.mark.django_db
def test_job_of_org_a_cannot_be_run_under_org_b(org_a, org_b, crm):
    job = crm.make_export_job(org_a)
    result = run_export.apply(
        kwargs={
            "job_id": str(job.pk),
            "organization_id": str(org_b.org.pk),
            "actor_membership_id": str(org_b.owner_membership.pk),
        }
    ).get()
    assert result == "skipped"
    from apps.core.tenancy.context import tenant_context
    from apps.importexport.models import ExportJob

    with tenant_context(org_a.org.pk, reason="test"):
        assert ExportJob.objects.get(pk=job.pk).status == JobStatus.PENDING


@pytest.mark.django_db
def test_per_organization_job_quota_is_enforced_and_independent(org_a, org_b, client_for, settings, reauthenticate):
    settings.MAX_ACTIVE_JOBS_PER_ORG = 1
    a = client_for(org_a.owner, org_a.owner_membership)
    reauthenticate(a)
    assert a.post("/api/v1/exports/contacts/", {"filters": {}}, format="json").status_code == 202
    resp = a.post("/api/v1/exports/contacts/", {"filters": {}}, format="json")
    assert resp.status_code == 429
    assert resp.json()["type"] == "too_many_active_jobs"
    b = client_for(org_b.owner, org_b.owner_membership)
    reauthenticate(b)
    assert b.post("/api/v1/exports/contacts/", {"filters": {}}, format="json").status_code == 202


def test_email_task_is_idempotent_on_redelivery(settings):
    settings.EMAIL_ASYNC = False
    message_id = queue_email(subject="hi", body="body", to=["a@example.com"])
    assert len(mail.outbox) == 1
    # A redelivered copy of the same message (worker lost after sending) is dropped.
    send_email.apply(kwargs={"message_id": message_id, "subject": "hi", "body": "body", "to": ["a@example.com"]})
    assert len(mail.outbox) == 1


def test_signup_emails_go_through_the_queue(db, anon_client, settings, django_capture_on_commit_callbacks):
    settings.EMAIL_ASYNC = True  # eager in tests: still executed, but via the task path
    csrf = anon_client.get("/api/v1/session/")
    token = csrf.cookies[settings.CSRF_COOKIE_NAME].value
    with django_capture_on_commit_callbacks(execute=True):
        resp = anon_client.post(
            "/_allauth/browser/v1/auth/signup",
            {"email": "new-user@example.com", "password": "Str0ng-Passw0rd-123!"},
            format="json",
            HTTP_X_CSRFTOKEN=token,
        )
    assert resp.status_code in (200, 401)
    assert any("new-user@example.com" in m.to for m in mail.outbox)
