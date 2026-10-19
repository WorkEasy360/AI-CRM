"""Background jobs and Workeasy360 entitlement (completion design section 5, docs/workeasy360-sso.md):
a job with a customer business effect asks about the organization first; denied, it skips the effect,
logs it, raises nothing and leaves the work where it is. Only organizations linked to Workeasy360 are asked."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.db import connection as db_connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from structlog.testing import capture_logs

from apps.accounts.models import Organization
from apps.accounts.workeasy360 import background, config, entitlement
from apps.core.tenancy.context import system_context, tenant_context
from tests.accounts import workeasy360_fake as fake

pytestmark = [pytest.mark.django_db, pytest.mark.security]

W360_A = "7d0c7a52-9f43-4f0e-8a3b-1d2e3f4a5b6c"
W360_B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
DENY = {"decision": "deny", "reason": "expired", "write_allowed": False}
ALLOW = {"decision": "allow", "reason": "entitled", "write_allowed": True, "revalidate_after": 900}


@pytest.fixture
def provider(settings, monkeypatch):
    provider = fake.FakeProvider()
    settings.WORKEASY360_ISSUER = fake.ISSUER
    settings.WORKEASY360_CLIENT_ID = fake.CLIENT_ID
    settings.WORKEASY360_REDIRECT_URI = fake.REDIRECT_URI
    settings.WORKEASY360_KEY_ID = fake.CLIENT_KID
    settings.WORKEASY360_PRIVATE_KEY = provider.client_private_pem
    monkeypatch.setattr(config, "transport_override", provider.transport)
    return provider


def _link(bundle, workeasy360_id: str | None) -> None:
    with system_context("test.link_organization"):
        Organization.objects.filter(pk=bundle.org.pk).update(workeasy360_organization_id=workeasy360_id)


@pytest.fixture
def linked(provider, org_a):
    """org_a is the Workeasy360 organization W360_A."""
    _link(org_a, W360_A)
    return org_a


def _age(workeasy360_id: str, seconds: int) -> None:
    key = entitlement._key(workeasy360_id)
    record = cache.get(key)
    record["checked_at"] -= seconds
    cache.set(key, record, entitlement.LAST_KNOWN_KEEP_SECONDS)


def _skips(logs: list[dict]) -> list[dict]:
    return [entry for entry in logs if entry["event"] == "workeasy360.background_skipped"]


# --- the gate ---------------------------------------------------------------------------------------------


def test_an_entitled_organization_may_run_and_is_asked_about_alone(provider, linked):
    assert background.allowed(linked.org.pk, task="t") is True
    (call,) = provider.entitlement_calls()
    assert call["organization_id"] == W360_A and "subject" not in call


def test_a_denial_skips_the_effect_and_is_logged_with_organization_task_and_reason(provider, linked):
    provider.entitlement = DENY
    with capture_logs() as logs:
        assert background.allowed(linked.org.pk, task="messaging.send_email_message") is False
    (entry,) = _skips(logs)
    assert entry["organization_id"] == str(linked.org.pk)
    assert entry["task"] == "messaging.send_email_message" and entry["reason"] == "expired"


def test_a_read_only_organization_runs_nothing_either(provider, linked):
    provider.entitlement = {"decision": "allow", "reason": "entitled", "write_allowed": False}
    with capture_logs() as logs:
        assert background.allowed(linked.org.pk, task="t") is False
    assert _skips(logs)[0]["reason"] == "read_only"


def test_a_denial_is_trusted_for_fifteen_minutes_not_sixty_seconds(provider, linked):
    provider.entitlement = DENY
    assert background.allowed(linked.org.pk, task="t") is False
    _age(W360_A, entitlement.DENIAL_RECHECK_SECONDS + 60)  # past what a waiting person would tolerate
    assert background.allowed(linked.org.pk, task="t") is False
    assert len(provider.entitlement_calls()) == 1  # not asked again
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS)
    assert background.allowed(linked.org.pk, task="t") is True  # the renewal is seen within the window
    assert len(provider.entitlement_calls()) == 2


def test_an_outage_keeps_the_last_answer_and_with_none_the_job_runs(provider, linked):
    provider.entitlement_status = 503
    assert background.allowed(linked.org.pk, task="t") is True  # nothing known yet: run
    cache.clear()
    entitlement.clear_local()
    provider.entitlement_status = 200
    provider.entitlement = DENY
    assert background.allowed(linked.org.pk, task="t") is False
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    provider.entitlement_status = 503
    assert background.allowed(linked.org.pk, task="t") is False  # an outage never turns a denial into work
    provider.entitlement_status = 200
    provider.entitlement = ALLOW
    cache.clear()
    entitlement.clear_local()
    assert background.allowed(linked.org.pk, task="t") is True
    _age(W360_A, 901)
    provider.entitlement_status = 503
    assert background.allowed(linked.org.pk, task="t") is True  # the last answer (allow) stands


def test_a_refusal_of_the_product_client_skips_the_effect_and_is_asked_again_soon(provider, linked):
    provider.entitlement_status = 401
    assert background.allowed(linked.org.pk, task="t") is False  # fails closed, like a request
    provider.entitlement_status = 200
    cache.delete(entitlement._CLIENT_REFUSED_KEY)  # the 60 s every question is closed for have passed
    entitlement._local_refused_until = 0.0
    _age(W360_A, entitlement.DENIAL_RECHECK_SECONDS + 1)  # not the 15 minutes of a plain denial
    assert background.allowed(linked.org.pk, task="t") is True


def test_a_keel_only_organization_is_never_asked(provider, org_a):
    assert background.allowed(org_a.org.pk, task="t") is True
    assert provider.entitlement_calls() == []


def test_nothing_is_asked_when_workeasy360_is_not_configured(org_a, settings):
    settings.WORKEASY360_ISSUER = ""
    assert background.allowed(org_a.org.pk, task="t") is True


def test_the_job_answer_is_shared_with_requests_that_have_no_person(provider, linked):
    background.allowed(linked.org.pk, task="t")
    with tenant_context(linked.org.pk):
        organization = Organization.objects.get(pk=linked.org.pk)
    access = entitlement.access_for(organization)  # a Keel-only account's request: organization level
    assert access is not None and access.allowed
    assert len(provider.entitlement_calls()) == 1


def test_organizations_are_checked_independently(provider, org_a, org_b):
    _link(org_a, W360_A)
    _link(org_b, W360_B)
    provider.entitlement_by_organization[W360_A] = DENY
    assert background.denied_organizations([org_a.org.pk, org_b.org.pk], task="t") == {org_a.org.pk}


# --- sweeps: a denied organization's backlog stays put and does not crowd out the others --------------------


def test_a_sweep_excludes_a_denied_organizations_backlog_from_the_batch(provider, org_a, org_b):
    _link(org_a, W360_A)
    _link(org_b, W360_B)
    provider.entitlement_by_organization[W360_A] = DENY
    batch = 2
    rows = [(org_a.org.pk, n) for n in range(5)] + [(org_b.org.pk, n) for n in range(5)]

    def fetch(excluded):
        return [r for r in rows if r[0] not in excluded][:batch]

    got = background.fetch_allowed(fetch, task="t")
    assert got == [(org_b.org.pk, 0), (org_b.org.pk, 1)]  # the first read was all org A; org B still got its turn


# --- the jobs ---------------------------------------------------------------------------------------------


def _due_reminder(bundle, crm):
    now = timezone.now()
    with tenant_context(bundle.org.pk, user_id=bundle.owner.pk, membership_id=bundle.owner_membership.pk):
        from apps.activities.models import Activity

        return Activity.objects.create(
            kind="task",
            title="Call back",
            reminder_minutes=30,
            reminder_at=now - timedelta(minutes=1),
            start_at=now + timedelta(minutes=10),
            owner=bundle.owner_membership,
        )


def _unsent(bundle, activity) -> bool:
    from apps.activities.models import Activity

    with tenant_context(bundle.org.pk):
        return Activity.objects.get(pk=activity.pk).reminder_sent_at is None


def test_reminders_wait_while_access_is_ended_then_go_out(provider, linked, crm):
    from apps.activities.tasks import send_reminders

    activity = _due_reminder(linked, crm)
    provider.entitlement = DENY
    assert send_reminders() == 0
    assert _unsent(linked, activity)  # left to resume after renewal
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    assert send_reminders() == 1
    assert not _unsent(linked, activity)


def test_reminders_go_out_for_an_unlinked_organization(provider, org_a, crm):
    from apps.activities.tasks import send_reminders

    activity = _due_reminder(org_a, crm)
    assert send_reminders() == 1 and not _unsent(org_a, activity)
    assert provider.entitlement_calls() == []


def test_reminders_of_other_organizations_go_out_while_one_is_denied(provider, org_a, org_b, crm, monkeypatch):
    from apps.activities import tasks

    _link(org_a, W360_A)
    provider.entitlement_by_organization[W360_A] = DENY
    monkeypatch.setattr(tasks, "REMINDER_BATCH", 1)
    denied = _due_reminder(org_a, crm)
    fine = _due_reminder(org_b, crm)
    assert tasks.send_reminders() == 1
    assert _unsent(org_a, denied) and not _unsent(org_b, fine)


def test_the_daily_deal_sweep_skips_a_denied_organization(provider, linked, org_b, crm):
    from datetime import timedelta as td

    from apps.deals.models import Deal
    from apps.notifications.models import Notification
    from apps.notifications.tasks import deal_health_sweep

    deals = {}
    for bundle in (linked, org_b):
        deals[bundle.org.pk] = crm.make_deal(bundle, name="Stale")
        with tenant_context(bundle.org.pk):
            Deal.objects.filter(pk=deals[bundle.org.pk].pk).update(
                stage_entered_at=timezone.now() - td(days=40),
                expected_close_date=timezone.now().date() - td(days=3),
            )
    provider.entitlement = DENY
    assert deal_health_sweep() == 2  # only org_b's deal (inactivity + high risk)
    with tenant_context(linked.org.pk):
        assert Notification.objects.count() == 0
    with tenant_context(org_b.org.pk):
        assert Notification.objects.count() == 2


def test_indexing_waits_while_access_is_ended(provider, linked, org_b, crm):
    from apps.rag.models import IndexEvent, IndexStatus, KnowledgeChunk, SourceType
    from apps.rag.tasks import index_source

    note = crm.make_note(linked, record=crm.make_deal(linked), body="Customer asked about pricing.")
    other = crm.make_note(org_b, record=crm.make_deal(org_b), body="Customer asked about pricing.")
    provider.entitlement = DENY
    for bundle, source in ((linked, note), (org_b, other)):
        index_source(organization_id=str(bundle.org.pk), source_type=SourceType.NOTE, source_id=str(source.pk))
    with tenant_context(linked.org.pk):
        assert KnowledgeChunk.objects.count() == 0  # nothing embedded
        assert IndexEvent.objects.get(source_id=note.pk).status == IndexStatus.PENDING  # still queued
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    index_source(organization_id=str(linked.org.pk), source_type=SourceType.NOTE, source_id=str(note.pk))
    with tenant_context(linked.org.pk):
        assert KnowledgeChunk.objects.count() == 1


def test_indexing_runs_for_an_unlinked_organization(provider, org_b, crm):
    from apps.rag.models import KnowledgeChunk, SourceType
    from apps.rag.tasks import index_source

    note = crm.make_note(org_b, record=crm.make_deal(org_b), body="Customer asked about pricing.")
    index_source(organization_id=str(org_b.org.pk), source_type=SourceType.NOTE, source_id=str(note.pk))
    with tenant_context(org_b.org.pk):
        assert KnowledgeChunk.objects.count() == 1
    assert provider.entitlement_calls() == []


def test_the_index_sweeper_leaves_a_denied_organizations_events_and_serves_the_others(
    provider, linked, org_b, crm, monkeypatch
):
    from apps.rag import tasks

    crm.make_index_event(linked)
    crm.make_index_event(org_b)
    dispatched: list[dict] = []
    monkeypatch.setattr(tasks.index_source, "delay", lambda **kw: dispatched.append(kw))
    provider.entitlement = DENY
    assert tasks.drain_pending() == 1
    assert [d["organization_id"] for d in dispatched] == [str(org_b.org.pk)]
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    dispatched.clear()
    assert tasks.drain_pending() == 2


def test_a_rebuild_is_not_started_for_a_denied_organization(provider, linked, crm, monkeypatch):
    from apps.rag import events, tasks

    crm.make_note(linked, record=crm.make_deal(linked), body="x")
    queued: list = []
    monkeypatch.setattr(events, "enqueue", lambda **kw: queued.append(kw))
    provider.entitlement = DENY
    assert tasks.rebuild_organization(organization_id=str(linked.org.pk), source_types=["note"]) == 0
    assert queued == []
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    assert tasks.rebuild_organization(organization_id=str(linked.org.pk), source_types=["note"]) == 1


@pytest.mark.parametrize(
    ("task_name", "claim"), [("send_email_message", "claim_email"), ("send_whatsapp_message", "claim_whatsapp")]
)
def test_outbound_messages_are_not_sent_while_access_is_ended(provider, linked, monkeypatch, task_name, claim):
    from apps.messaging import tasks

    claimed: list = []
    monkeypatch.setattr(tasks.services, claim, lambda *a, **k: claimed.append(a) or None)
    run = getattr(tasks, task_name)
    kwargs = {
        "message_id": str(uuid.uuid4()),
        "organization_id": str(linked.org.pk),
        "actor_membership_id": str(linked.owner_membership.pk),
    }
    provider.entitlement = DENY
    assert run(**kwargs) == "access_ended" and claimed == []  # not even claimed: it stays queued
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    assert run(**kwargs) == "skipped" and len(claimed) == 1  # reached the claim (which found nothing to send)


@pytest.mark.parametrize(
    ("task_name", "claim"), [("send_email_message", "claim_email"), ("send_whatsapp_message", "claim_whatsapp")]
)
def test_outbound_messages_are_sent_for_an_unlinked_organization(provider, org_a, monkeypatch, task_name, claim):
    from apps.messaging import tasks

    claimed: list = []
    monkeypatch.setattr(tasks.services, claim, lambda *a, **k: claimed.append(a) or None)
    getattr(tasks, task_name)(
        message_id=str(uuid.uuid4()),
        organization_id=str(org_a.org.pk),
        actor_membership_id=str(org_a.owner_membership.pk),
    )
    assert len(claimed) == 1 and provider.entitlement_calls() == []


def test_mailbox_sync_fans_out_only_for_allowed_organizations(provider, linked, org_b, crm, monkeypatch):
    from apps.messaging import tasks

    crm.make_email_account(linked)
    crm.make_email_account(org_b)
    sent: list[dict] = []
    monkeypatch.setattr(tasks.sync_email_account, "apply_async", lambda **kw: sent.append(kw["kwargs"]))
    provider.entitlement = DENY
    assert tasks.sync_email_accounts() == 1
    assert [s["organization_id"] for s in sent] == [str(org_b.org.pk)]


def test_a_mailbox_is_not_synced_while_access_is_ended(provider, linked, crm, monkeypatch):
    from apps.messaging import tasks

    account = crm.make_email_account(linked)
    synced: list = []
    monkeypatch.setattr(tasks.services, "sync_account", lambda a: synced.append(a) or 3)
    kwargs = {"account_id": str(account.pk), "organization_id": str(linked.org.pk)}
    provider.entitlement = DENY
    assert tasks.sync_email_account(**kwargs) == 0 and synced == []
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    assert tasks.sync_email_account(**kwargs) == 3 and len(synced) == 1


def _pending_import(bundle, crm):
    from apps.importexport.models import ImportJob, JobStatus

    job = crm.make_import_job(bundle)
    with tenant_context(bundle.org.pk):
        ImportJob.objects.filter(pk=job.pk).update(status=JobStatus.PENDING)
    return job


def test_an_import_waits_while_access_is_ended_and_is_left_pending(provider, linked, crm, monkeypatch):
    from apps.importexport import service, tasks
    from apps.importexport.models import ImportJob, JobStatus

    job = _pending_import(linked, crm)
    processed: list = []
    monkeypatch.setattr(service, "process_import", lambda j, actor: processed.append(j))
    monkeypatch.setattr(service, "_actor_for_task", lambda membership_id: object())
    kwargs = {
        "job_id": str(job.pk),
        "organization_id": str(linked.org.pk),
        "actor_membership_id": str(linked.owner_membership.pk),
    }
    provider.entitlement = DENY
    assert tasks.run_import(**kwargs) == "access_ended" and processed == []
    with tenant_context(linked.org.pk):
        assert ImportJob.objects.get(pk=job.pk).status == JobStatus.PENDING
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    assert tasks.run_import(**kwargs) == "completed" and len(processed) == 1


def test_an_import_runs_for_an_unlinked_organization(provider, org_a, crm, monkeypatch):
    from apps.importexport import service, tasks

    job = _pending_import(org_a, crm)
    processed: list = []
    monkeypatch.setattr(service, "process_import", lambda j, actor: processed.append(j))
    monkeypatch.setattr(service, "_actor_for_task", lambda membership_id: object())
    assert (
        tasks.run_import(
            job_id=str(job.pk),
            organization_id=str(org_a.org.pk),
            actor_membership_id=str(org_a.owner_membership.pk),
        )
        == "completed"
    )
    assert len(processed) == 1 and provider.entitlement_calls() == []


def test_the_import_resume_sweep_skips_a_denied_organization(provider, linked, org_b, crm, monkeypatch):
    from apps.importexport import tasks
    from apps.importexport.models import ImportJob, JobStatus

    jobs = [crm.make_import_job(linked), crm.make_import_job(org_b)]
    for bundle, job in zip((linked, org_b), jobs, strict=True):
        with tenant_context(bundle.org.pk):
            ImportJob.objects.filter(pk=job.pk).update(
                status=JobStatus.RUNNING, updated_at=timezone.now() - timedelta(hours=2)
            )
    resumed: list[dict] = []
    monkeypatch.setattr(tasks.run_import, "apply_async", lambda **kw: resumed.append(kw["kwargs"]))
    provider.entitlement = DENY
    assert tasks.resume_stalled_imports() == 1
    assert [r["organization_id"] for r in resumed] == [str(org_b.org.pk)]


def test_exports_and_cleanup_are_class_b_and_never_asked(provider, linked, crm, monkeypatch):
    """A customer can still finish an export they asked for, and retention jobs run, after access ends."""
    from apps.importexport import service, tasks

    provider.entitlement = DENY
    job = crm.make_export_job(linked)
    monkeypatch.setattr(service, "process_export", lambda j, actor: None)
    monkeypatch.setattr(service, "_actor_for_task", lambda membership_id: object())
    assert (
        tasks.run_export(
            job_id=str(job.pk),
            organization_id=str(linked.org.pk),
            actor_membership_id=str(linked.owner_membership.pk),
        )
        == "completed"
    )
    tasks.purge_expired()
    tasks.fail_stale_jobs()
    assert provider.entitlement_calls() == []


# integrations: the tasks run from ids that need no setup to reach their first query, so "reached the lookup"
# (``skipped``: no such row) tells the allowed path from the denied one (``access_ended``).
_INTEGRATION_TASKS = [
    ("deliver", "delivery_id"),
    ("run_sync_job", "job_id"),
    ("process_inbound_event", "event_id"),
    ("schedule_sync", "connection_id"),
]


@pytest.mark.parametrize(("name", "id_arg"), _INTEGRATION_TASKS)
def test_integration_tasks_do_nothing_while_access_is_ended(provider, linked, name, id_arg):
    from apps.integrations import tasks

    run = getattr(tasks, name)
    kwargs = {id_arg: str(uuid.uuid4()), "organization_id": str(linked.org.pk)}
    provider.entitlement = DENY
    with CaptureQueriesContext(db_connection) as queries:
        assert run(**kwargs) == "access_ended"
    assert not [q for q in queries.captured_queries if "integrations_" in q["sql"]]  # touched no integration row
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    assert run(**kwargs) == "skipped"  # the lookup ran (and found nothing)


@pytest.mark.parametrize(("name", "id_arg"), _INTEGRATION_TASKS)
def test_integration_tasks_run_for_an_unlinked_organization(provider, org_a, name, id_arg):
    from apps.integrations import tasks

    kwargs = {id_arg: str(uuid.uuid4()), "organization_id": str(org_a.org.pk)}
    assert getattr(tasks, name)(**kwargs) == "skipped"
    assert provider.entitlement_calls() == []


def test_event_dispatch_leaves_the_event_pending_while_access_is_ended(provider, linked):
    from apps.integrations import tasks

    kwargs = {"event_id": str(uuid.uuid4()), "organization_id": str(linked.org.pk)}
    provider.entitlement = DENY
    with CaptureQueriesContext(db_connection) as queries:
        assert tasks.dispatch_event(**kwargs) == 0
    assert not [q for q in queries.captured_queries if "integrations_integrationevent" in q["sql"]]
    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    with CaptureQueriesContext(db_connection) as queries:
        assert tasks.dispatch_event(**kwargs) == 0
    assert [q for q in queries.captured_queries if "integrations_integrationevent" in q["sql"]]


def test_scheduled_syncs_start_for_allowed_organizations_only(provider, linked, org_b, crm, monkeypatch):
    from apps.integrations import services, tasks

    started: list = []
    monkeypatch.setattr(services, "start_sync", lambda *a, **k: started.append(a[1].organization_id))
    connections = [crm.make_integration_connection(bundle, sync_interval_minutes=15) for bundle in (linked, org_b)]
    provider.entitlement_by_organization[W360_A] = DENY
    for bundle, conn in zip((linked, org_b), connections, strict=True):
        assert tasks.schedule_sync(connection_id=str(conn.pk), organization_id=str(bundle.org.pk)) == (
            "access_ended" if bundle is linked else "started"
        )
    assert started == [org_b.org.pk]


def test_the_integration_sweeper_enqueues_only_for_allowed_organizations(provider, linked, org_b, crm, monkeypatch):
    from apps.integrations import tasks
    from apps.integrations.models import IntegrationConnection

    connections = [crm.make_integration_connection(bundle, sync_interval_minutes=15) for bundle in (linked, org_b)]
    for bundle, conn in zip((linked, org_b), connections, strict=True):
        with tenant_context(bundle.org.pk):
            IntegrationConnection.objects.filter(pk=conn.pk).update(next_sync_at=timezone.now() - timedelta(minutes=1))
    enqueued: list[dict] = []
    monkeypatch.setattr(tasks.schedule_sync, "delay", lambda **kw: enqueued.append(kw))
    provider.entitlement_by_organization[W360_A] = DENY
    assert tasks.drain()["scheduled"] == 1
    assert [e["organization_id"] for e in enqueued] == [str(org_b.org.pk)]
    # Renewed: the connection is still due, so the next sweep picks it up (the schedule was left alone).
    provider.entitlement_by_organization.clear()
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    enqueued.clear()
    assert tasks.drain()["scheduled"] == 2
    assert {e["organization_id"] for e in enqueued} == {str(linked.org.pk), str(org_b.org.pk)}


def test_a_gated_task_never_raises_for_a_denied_organization(provider, linked, crm):
    """No exception means no retry loop: celery only retries a task that raises."""
    from apps.activities.tasks import send_reminders

    provider.entitlement = DENY
    _due_reminder(linked, crm)
    assert send_reminders() == 0


def test_transactional_account_mail_is_not_gated(provider, linked, mailoutbox):
    from apps.accounts.tasks import queue_email

    provider.entitlement = DENY
    queue_email(subject="Reset", body="b", to=["a@example.com"])
    assert len(mailoutbox) == 1 and provider.entitlement_calls() == []


# --- skipped work resumes exactly once after renewal ---------------------------------------------------------


def _backdate(model, bundle, pk, *, field: str = "updated_at", minutes: int = 10) -> None:
    with tenant_context(bundle.org.pk):
        model.objects.filter(pk=pk).update(**{field: timezone.now() - timedelta(minutes=minutes)})


def _inbound_event(bundle, crm, *, minutes: int = 10):
    from apps.integrations.models import InboundEvent

    connection = crm.make_integration_connection(bundle)
    with tenant_context(bundle.org.pk):
        event = InboundEvent.objects.create(
            connection=connection, event_id=uuid.uuid4().hex, event_type="x", payload={"a": 1}, payload_sha256="0" * 64
        )
    _backdate(InboundEvent, bundle, event.pk, field="created_at", minutes=minutes)
    return event


def test_stale_inbound_events_resume_after_renewal_and_are_applied_once(provider, linked, org_b, crm, monkeypatch):
    from apps.integrations import tasks, webhooks
    from apps.integrations.models import InboundEvent

    denied = _inbound_event(linked, crm)
    fine = _inbound_event(org_b, crm)
    fresh = _inbound_event(org_b, crm, minutes=1)  # a webhook that has only just arrived is left to its own task
    enqueued: list[dict] = []
    monkeypatch.setattr(tasks.process_inbound_event, "delay", lambda **kw: enqueued.append(kw))
    provider.entitlement_by_organization[W360_A] = DENY
    assert tasks.drain()["inbound"] == 1
    assert [e["event_id"] for e in enqueued] == [str(fine.pk)] and str(fresh.pk) not in str(enqueued)
    with tenant_context(linked.org.pk):
        assert InboundEvent.objects.get(pk=denied.pk).status == InboundEvent.Status.RECEIVED  # kept, not dropped

    # Renewal: the next sweep hands it over, and handing it over twice applies it once.
    provider.entitlement_by_organization.clear()
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    enqueued.clear()
    assert tasks.drain()["inbound"] == 2
    assert str(denied.pk) in {e["event_id"] for e in enqueued}
    applied: list = []

    def apply_event(event):
        applied.append(event.pk)
        InboundEvent.objects.filter(pk=event.pk).update(status=InboundEvent.Status.PROCESSED)
        return "processed"

    monkeypatch.setattr(webhooks, "process_inbound", apply_event)
    kwargs = {"event_id": str(denied.pk), "organization_id": str(linked.org.pk)}
    assert tasks.process_inbound_event(**kwargs) == "processed"
    assert tasks.process_inbound_event(**kwargs) == "skipped"  # the second hand-over finds it processed
    assert applied == [denied.pk]


@pytest.mark.parametrize("channel", ["email", "whatsapp"])
def test_stale_queued_sends_resume_after_renewal_and_are_sent_once(provider, linked, org_b, crm, monkeypatch, channel):
    from apps.messaging import services, tasks
    from apps.messaging.models import EmailMessage, WhatsAppMessage

    model, make, task_name, deliver = (
        (EmailMessage, crm.make_email_message, "send_email_message", "deliver_email")
        if channel == "email"
        else (WhatsAppMessage, crm.make_whatsapp_message, "send_whatsapp_message", "deliver_whatsapp")
    )
    messages = {bundle.org.pk: make(bundle, status="queued") for bundle in (linked, org_b)}
    fresh = make(org_b, status="queued")  # queued a moment ago: its own task is still on its way
    for bundle in (linked, org_b):
        _backdate(model, bundle, messages[bundle.org.pk].pk)
    sent: list = []
    monkeypatch.setattr(services, deliver, lambda message: sent.append(message.pk) or "sent")
    run = getattr(tasks, task_name)
    enqueued: list[dict] = []
    monkeypatch.setattr(run, "apply_async", lambda **kw: enqueued.append(kw["kwargs"]))

    provider.entitlement_by_organization[W360_A] = DENY
    assert tasks.resume_queued_sends() == 1
    assert [e["message_id"] for e in enqueued] == [str(messages[org_b.org.pk].pk)]
    assert str(fresh.pk) not in str(enqueued)

    provider.entitlement_by_organization.clear()
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    enqueued.clear()
    assert tasks.resume_queued_sends() == 2
    resumed = next(e for e in enqueued if e["organization_id"] == str(linked.org.pk))
    # Two hand-overs of the same message: the claim (QUEUED -> SENDING) is atomic, so it is sent once.
    assert run(**resumed) == "sent"
    assert run(**resumed) == "skipped"
    assert sent == [messages[linked.org.pk].pk]


def test_the_queued_send_sweep_is_a_scheduled_task_on_the_notifications_queue(settings):
    from config.celery import app

    assert settings.CELERY_BEAT_SCHEDULE["messaging.resume_queued_sends"]["task"] == "messaging.resume_queued_sends"
    assert app.amqp.router.route({}, "messaging.resume_queued_sends")["queue"].name == "notifications"


def _parked_import(bundle, crm):
    from apps.importexport.models import ImportJob, JobStatus
    from apps.importexport.tasks import WAITING_FOR_ACCESS_MESSAGE

    job = crm.make_import_job(bundle)
    with tenant_context(bundle.org.pk):
        ImportJob.objects.filter(pk=job.pk).update(
            status=JobStatus.PENDING,
            error_message=WAITING_FOR_ACCESS_MESSAGE,
            updated_at=timezone.now() - timedelta(hours=5),
        )
    return job


def test_a_skipped_import_is_marked_waiting_and_resumes_once_after_renewal(provider, linked, crm, monkeypatch):
    from apps.importexport import tasks
    from apps.importexport.models import ImportJob, JobStatus

    job = _pending_import(linked, crm)
    resumed: list[dict] = []
    monkeypatch.setattr(tasks.run_import, "apply_async", lambda **kw: resumed.append(kw["kwargs"]))
    provider.entitlement = DENY
    kwargs = {
        "job_id": str(job.pk),
        "organization_id": str(linked.org.pk),
        "actor_membership_id": str(linked.owner_membership.pk),
    }
    assert tasks.run_import(**kwargs) == "access_ended"
    with tenant_context(linked.org.pk):
        row = ImportJob.objects.get(pk=job.pk)
    assert row.status == JobStatus.PENDING and row.error_message == tasks.WAITING_FOR_ACCESS_MESSAGE
    assert tasks.resume_stalled_imports() == 0 and resumed == []  # still denied: nothing to resume

    provider.entitlement = ALLOW
    _age(W360_A, entitlement.BACKGROUND_DENIAL_SECONDS + 1)
    assert tasks.resume_stalled_imports() == 1
    assert resumed == [kwargs]
    assert tasks.resume_stalled_imports() == 0  # claimed: the marker is gone, so no second hand-over
    with tenant_context(linked.org.pk):
        assert ImportJob.objects.get(pk=job.pk).error_message == ""


def test_stale_job_cleanup_leaves_a_denied_organizations_imports_alone(provider, linked, org_b, crm):
    from apps.importexport.models import ExportJob, ImportJob, JobStatus
    from apps.importexport.tasks import fail_stale_jobs

    waiting = _parked_import(linked, crm)
    lost = _parked_import(org_b, crm)  # an allowed organization's job that never reached a worker
    export = crm.make_export_job(linked)
    with tenant_context(linked.org.pk):
        ExportJob.objects.filter(pk=export.pk).update(
            status=JobStatus.PENDING, updated_at=timezone.now() - timedelta(hours=5)
        )
    provider.entitlement_by_organization[W360_A] = DENY
    assert fail_stale_jobs.apply().get() == 2  # org_b's import and the (class B) export
    with tenant_context(linked.org.pk):
        assert ImportJob.objects.get(pk=waiting.pk).status == JobStatus.PENDING
        assert ExportJob.objects.get(pk=export.pk).status == JobStatus.FAILED
    with tenant_context(org_b.org.pk):
        assert ImportJob.objects.get(pk=lost.pk).status == JobStatus.FAILED


# --- Celery's time limit is not an outage --------------------------------------------------------------------


def test_a_celery_soft_time_limit_propagates_out_of_the_check(provider, linked, monkeypatch):
    from celery.exceptions import SoftTimeLimitExceeded

    def out_of_time(*_args, **_kwargs):
        raise SoftTimeLimitExceeded

    monkeypatch.setattr(config.get_client(), "verify_entitlement", out_of_time)
    with pytest.raises(SoftTimeLimitExceeded):
        background.allowed(linked.org.pk, task="t")
    key = entitlement._key(W360_A)
    assert cache.get(f"{key}:refreshing") is None  # the single-flight lock is released
    assert cache.get(f"{key}:backoff") is None  # and it was not recorded as a Workeasy360 outage
    assert cache.get(key) is None  # nor as an answer


def test_a_client_refusal_skips_every_organizations_jobs_without_asking(provider, org_a, org_b):
    _link(org_a, W360_A)
    _link(org_b, W360_B)
    provider.entitlement_status = 401
    assert background.allowed(org_a.org.pk, task="t") is False
    asked = len(provider.entitlement_calls())
    provider.entitlement_status = 200
    with capture_logs() as logs:
        assert background.allowed(org_b.org.pk, task="t") is False  # another organization, never asked about
    assert len(provider.entitlement_calls()) == asked
    assert _skips(logs)[0]["reason"] == "refused"
