"""Automation rules: management permissions, plan limit, firing as the record owner, idempotency, isolation."""

from __future__ import annotations

import pytest

from apps.activities.models import Activity
from apps.audit.models import AuditEvent
from apps.automation.models import AutomationRule, AutomationRun
from apps.core.tenancy.context import tenant_context
from apps.notifications.models import Notification

pytestmark = pytest.mark.django_db


def _rule(client, **body):
    body.setdefault("name", "Follow-up Reminder")
    body.setdefault("trigger", "contact_created")
    body.setdefault("action", "create_task")
    return client.post("/api/v1/automation-rules/", body, format="json")


def test_rule_management_and_audit(org_a, owner_client, client_for, make_member):
    resp = _rule(owner_client, message="Call the new lead", delay_days=2)
    assert resp.status_code == 201, resp.content
    rule = resp.json()
    assert rule["is_enabled"] is True and rule["delay_days"] == 2
    with tenant_context(org_a.org.pk):
        assert AuditEvent.objects.filter(action="automation.created").exists()

    resp = owner_client.patch(f"/api/v1/automation-rules/{rule['id']}/", {"is_enabled": False}, format="json")
    assert resp.status_code == 200 and resp.json()["is_enabled"] is False
    assert owner_client.get("/api/v1/automation-rules/").json()["results"][0]["id"] == rule["id"]

    # validation
    assert _rule(owner_client, trigger="ticket_closed").status_code == 400
    assert _rule(owner_client, delay_days=91).status_code == 400
    assert _rule(owner_client, name="  ").status_code == 400

    # a sales manager sees the rules, a sales rep does not, and neither may change them
    manager = make_member(org_a, "sales_manager")
    rep = make_member(org_a, "sales_rep")
    manager_client = client_for(manager.user, manager)
    assert manager_client.get("/api/v1/automation-rules/").status_code == 200
    assert _rule(manager_client).status_code == 403
    assert manager_client.delete(f"/api/v1/automation-rules/{rule['id']}/").status_code == 403
    assert client_for(rep.user, rep).get("/api/v1/automation-rules/").status_code == 403

    assert owner_client.delete(f"/api/v1/automation-rules/{rule['id']}/").status_code == 204


def test_rules_fire_once_as_the_owner(org_a, owner_client, django_capture_on_commit_callbacks):
    task_rule = _rule(owner_client, message="Call the new lead", delay_days=2).json()
    _rule(owner_client, name="Welcome", action="notify_owner", message="New lead to welcome")
    _rule(owner_client, name="Disabled", is_enabled=False)

    with django_capture_on_commit_callbacks(execute=True):
        contact = owner_client.post(
            "/api/v1/contacts/", {"first_name": "Rahul", "last_name": "Sharma"}, format="json"
        ).json()

    with tenant_context(org_a.org.pk):
        tasks = list(Activity.objects.filter(contact_id=contact["id"], kind="task"))
        assert len(tasks) == 1
        assert tasks[0].title == "Call the new lead: Rahul Sharma"
        assert tasks[0].owner_id == org_a.owner_membership.pk
        assert Notification.objects.filter(kind="automation", entity_id=contact["id"]).count() == 1
        assert AutomationRun.objects.filter(entity_id=contact["id"]).count() == 2
        assert AutomationRule.objects.get(pk=task_rule["id"]).run_count == 1

    # a re-delivered event is a no-op
    from apps.automation.engine import run_rules

    assert run_rules(str(org_a.org.pk), "contact", [contact["id"]], "created") == 0
    with tenant_context(org_a.org.pk):
        assert Activity.objects.filter(contact_id=contact["id"], kind="task").count() == 1


def test_deal_won_rule(org_a, owner_client, crm, django_capture_on_commit_callbacks):
    _rule(owner_client, name="Deal Won Notification", trigger="deal_won", action="notify_owner", message="Deal won!")
    deal = crm.make_deal(org_a)
    with tenant_context(org_a.org.pk):
        won = next(s for s in deal.pipeline.stages.all() if s.kind == "won")
    with django_capture_on_commit_callbacks(execute=True):
        resp = owner_client.post(
            f"/api/v1/deals/{deal.pk}/stage/", {"stage_id": str(won.pk), "version": deal.version}, format="json"
        )
    assert resp.status_code == 200, resp.content
    with tenant_context(org_a.org.pk):
        assert Notification.objects.filter(kind="automation", entity_id=deal.pk, title="Deal won!").count() == 1


def test_rules_stay_inside_their_organization(
    org_a, org_b, owner_client, client_for, django_capture_on_commit_callbacks
):
    rule = _rule(owner_client).json()
    other = client_for(org_b.owner, org_b.owner_membership)
    assert other.get("/api/v1/automation-rules/").json()["results"] == []
    assert (
        other.patch(f"/api/v1/automation-rules/{rule['id']}/", {"is_enabled": False}, format="json").status_code == 404
    )
    assert other.delete(f"/api/v1/automation-rules/{rule['id']}/").status_code == 404
    # org A's rule does not fire for org B's contacts
    with django_capture_on_commit_callbacks(execute=True):
        contact = other.post("/api/v1/contacts/", {"first_name": "Neha"}, format="json").json()
    with tenant_context(org_b.org.pk):
        assert not Activity.objects.filter(contact_id=contact["id"]).exists()


def test_plan_limit_on_rules(owner_client, monkeypatch):
    from apps.billing import entitlements

    def _full(organization, metric, **kwargs):
        assert metric == "automation_rules"
        raise entitlements.LimitReached("Your plan's automation rules are used up.", code="limit_reached", upgrade={})

    monkeypatch.setattr(entitlements, "check_capacity", _full)
    resp = _rule(owner_client)
    assert resp.status_code == 403
    assert owner_client.get("/api/v1/automation-rules/").json()["results"] == []


# ----------------------------------------------------------------------------- WhatsApp and delayed steps


@pytest.fixture
def whatsapp(org_a, crm):
    from apps.messaging.providers.fake import FakeWhatsAppProvider

    FakeWhatsAppProvider.reset()
    crm.make_whatsapp_account(org_a)
    yield crm.make_whatsapp_template(org_a)  # body "Hello {{1}}"
    FakeWhatsAppProvider.reset()


def _wa_rule(client, template, **body):
    body.setdefault("name", "New Lead Welcome")
    body.setdefault("action", "send_whatsapp")
    body.setdefault("whatsapp_template_id", str(template.pk))
    body.setdefault("template_params", ["{{first_name}}"])
    return _rule(client, **body)


def _new_contact(client, capture, **body):
    with capture(execute=True):
        resp = client.post("/api/v1/contacts/", {"last_name": "Sharma", **body}, format="json")
    assert resp.status_code == 201, resp.content
    return resp.json()


def test_whatsapp_rule_validation(org_a, org_b, owner_client, crm, whatsapp):
    assert _rule(owner_client, action="send_whatsapp").status_code == 400  # no template
    assert _wa_rule(owner_client, whatsapp, template_params=[]).status_code == 400  # needs one value
    assert _wa_rule(owner_client, whatsapp, template_params=["  "]).status_code == 400
    foreign = crm.make_whatsapp_template(org_b)
    assert _wa_rule(owner_client, foreign).status_code == 400  # another organization's template

    resp = _wa_rule(owner_client, whatsapp, delay_days=3, only_if_no_reply=True)
    assert resp.status_code == 201, resp.content
    rule = resp.json()
    assert rule["whatsapp_template_name"] == whatsapp.name and rule["template_params"] == ["{{first_name}}"]
    assert rule["only_if_no_reply"] is True and rule["pending_runs"] == 0 and rule["last_outcome"] is None

    # another action drops the WhatsApp settings
    resp = owner_client.patch(f"/api/v1/automation-rules/{rule['id']}/", {"action": "notify_owner"}, format="json")
    assert resp.status_code == 200 and resp.json()["whatsapp_template_id"] is None
    # and switching back needs a template again
    resp = owner_client.patch(f"/api/v1/automation-rules/{rule['id']}/", {"action": "send_whatsapp"}, format="json")
    assert resp.status_code == 400


def test_welcome_whatsapp_goes_out_as_the_owner_only_with_consent(
    org_a, owner_client, whatsapp, django_capture_on_commit_callbacks
):
    from apps.messaging.models import WhatsAppMessage
    from apps.messaging.providers.fake import FakeWhatsAppProvider

    rule = _wa_rule(owner_client, whatsapp).json()
    consented = _new_contact(
        owner_client,
        django_capture_on_commit_callbacks,
        first_name="Rahul",
        phone="+91 98765 43210",
        whatsapp_opt_in=True,
    )
    with tenant_context(org_a.org.pk):
        message = WhatsAppMessage.objects.get(contact_id=consented["id"])
        assert message.sent_by_id == org_a.owner_membership.pk and message.body == "Hello Rahul"
        assert message.status == "sent"
    assert len(FakeWhatsAppProvider.sent) == 1 and FakeWhatsAppProvider.sent[0].template_params == ["Rahul"]

    # no recorded consent: nothing is sent, and the rule says why
    silent = _new_contact(owner_client, django_capture_on_commit_callbacks, first_name="Neha", phone="+91 98765 43211")
    with tenant_context(org_a.org.pk):
        assert not WhatsAppMessage.objects.filter(contact_id=silent["id"]).exists()
        run = AutomationRun.objects.get(entity_id=silent["id"])
        assert run.outcome == "skipped" and "opted in" in run.detail
    assert len(FakeWhatsAppProvider.sent) == 1
    listed = owner_client.get("/api/v1/automation-rules/").json()["results"][0]
    assert listed["id"] == rule["id"] and listed["last_outcome"] == "skipped" and listed["run_count"] == 2


def test_no_reply_reminder_waits_and_skips_when_the_contact_replied(
    org_a, owner_client, whatsapp, django_capture_on_commit_callbacks
):
    import datetime as dt

    from django.utils import timezone

    from apps.automation.engine import run_due
    from apps.messaging.models import WhatsAppMessage
    from apps.messaging.providers.fake import FakeWhatsAppProvider

    _wa_rule(owner_client, whatsapp, name="Follow-up Reminder", delay_days=3, only_if_no_reply=True)
    quiet = _new_contact(
        owner_client,
        django_capture_on_commit_callbacks,
        first_name="Amit",
        phone="+91 90000 00001",
        whatsapp_opt_in=True,
    )
    replied = _new_contact(
        owner_client,
        django_capture_on_commit_callbacks,
        first_name="Sara",
        phone="+91 90000 00002",
        whatsapp_opt_in=True,
    )
    assert FakeWhatsAppProvider.sent == []  # nothing before the three days are up
    assert owner_client.get("/api/v1/automation-rules/").json()["results"][0]["pending_runs"] == 2
    assert run_due() == 0  # not due yet

    with tenant_context(org_a.org.pk):
        WhatsAppMessage.objects.create(
            direction="inbound",
            status="received",
            wa_id="919000000002",
            contact_id=replied["id"],
            body="Thanks, got it",
            received_at=timezone.now(),
        )
        AutomationRun.objects.update(due_at=timezone.now() - dt.timedelta(minutes=1))  # three days later

    with django_capture_on_commit_callbacks(execute=True):
        assert run_due() == 1
    assert [m.template_params for m in FakeWhatsAppProvider.sent] == [["Amit"]]
    with tenant_context(org_a.org.pk):
        assert AutomationRun.objects.get(entity_id=replied["id"]).detail == "The contact replied."
        assert AutomationRun.objects.get(entity_id=quiet["id"]).outcome == "done"
    assert run_due() == 0  # each run acts once


def test_runs_wait_while_access_has_ended_then_go_out(
    org_a, owner_client, monkeypatch, django_capture_on_commit_callbacks
):
    from apps.accounts.workeasy360 import background
    from apps.automation.engine import run_due

    _rule(owner_client, name="Welcome", action="notify_owner", message="New lead")
    monkeypatch.setattr(background, "allowed", lambda organization_id, *, task: False)
    contact = _new_contact(owner_client, django_capture_on_commit_callbacks, first_name="Ravi")
    with tenant_context(org_a.org.pk):
        assert not Notification.objects.filter(kind="automation", entity_id=contact["id"]).exists()
        assert AutomationRun.objects.get(entity_id=contact["id"]).outcome == "pending"

    # the sweep leaves a denied organization out, and acts once access is back
    monkeypatch.setattr(background, "denied_organizations", lambda ids, *, task: set(ids))
    assert run_due() == 0
    monkeypatch.undo()
    assert run_due() == 1
    with tenant_context(org_a.org.pk):
        assert Notification.objects.filter(kind="automation", entity_id=contact["id"]).count() == 1
