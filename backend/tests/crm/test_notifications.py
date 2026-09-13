"""Notifications are private to their recipient; preferences gate channels; sweeps are bounded."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.core import mail
from django.utils import timezone

from apps.core.tenancy.context import tenant_context
from apps.deals.models import Deal
from apps.notifications import service
from apps.notifications.models import Notification
from apps.notifications.tasks import deal_health_sweep

pytestmark = pytest.mark.django_db


def test_notifications_are_recipient_private(org_a, org_b, owner_client, crm, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    crm.make_notification(org_a, recipient=org_a.owner_membership)
    crm.make_notification(org_a, recipient=rep)
    foreign = crm.make_notification(org_b)
    mine = owner_client.get("/api/v1/notifications/").json()["results"]
    assert len(mine) == 1
    assert owner_client.get("/api/v1/notifications/unread-count/").json()["count"] == 1
    assert owner_client.get(f"/api/v1/notifications/{foreign.pk}/").status_code == 404
    repc = client_for(rep.user, rep)
    assert len(repc.get("/api/v1/notifications/").json()["results"]) == 1
    assert (
        owner_client.post("/api/v1/notifications/read/", {"ids": [mine[0]["id"]]}, format="json").json()["updated"] == 1
    )
    assert owner_client.get("/api/v1/notifications/?unread=true").json()["results"] == []
    assert owner_client.post("/api/v1/notifications/read-all/", {}, format="json").json()["updated"] == 0


def test_preferences_gate_channels_and_dedupe(org_a, owner_client):
    resp = owner_client.patch(
        "/api/v1/notifications/preferences/",
        {"in_app": {"task_due": False}, "email": {"task_due": True}, "deal_inactive_days": 7},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    prefs = resp.json()
    assert (
        prefs["in_app"]["task_due"] is False and prefs["email"]["task_due"] is True and prefs["deal_inactive_days"] == 7
    )
    assert (
        owner_client.patch("/api/v1/notifications/preferences/", {"in_app": {"nope": True}}, format="json").status_code
        == 400
    )
    mail.outbox.clear()
    with tenant_context(org_a.org.pk):
        first = service.notify(
            org_a.owner_membership.pk,
            kind="task_due",
            title="Do it",
            entity_type="activity",
            entity_id=org_a.owner_membership.pk,
        )
        again = service.notify(
            org_a.owner_membership.pk,
            kind="task_due",
            title="Do it",
            entity_type="activity",
            entity_id=org_a.owner_membership.pk,
        )
    assert first is None and again is None  # in-app off
    assert len(mail.outbox) == 2 and "Do it" in mail.outbox[0].subject
    with tenant_context(org_a.org.pk):
        created = service.notify(
            org_a.owner_membership.pk,
            kind="deal_inactive",
            title="Cold",
            entity_type="deal",
            entity_id=org_a.owner_membership.pk,
        )
        duplicate = service.notify(
            org_a.owner_membership.pk,
            kind="deal_inactive",
            title="Cold",
            entity_type="deal",
            entity_id=org_a.owner_membership.pk,
        )
    assert created is not None and duplicate is None


def test_deal_assignment_notifies_new_owner(org_a, owner_client, crm, make_member):
    rep = make_member(org_a, "sales_rep")
    deal = crm.make_deal(org_a)
    resp = owner_client.patch(f"/api/v1/deals/{deal.pk}/", {"owner_id": str(rep.pk), "version": 1}, format="json")
    assert resp.status_code == 200, resp.content
    with tenant_context(org_a.org.pk):
        note = Notification.objects.get(recipient=rep)
    assert note.kind == "deal_assigned" and deal.name in note.title


def test_deal_health_sweep_warns_about_stale_and_risky_deals(org_a, crm):
    stale = crm.make_deal(org_a, name="Stale")
    with tenant_context(org_a.org.pk):
        Deal.objects.filter(pk=stale.pk).update(
            stage_entered_at=timezone.now() - timedelta(days=40),
            expected_close_date=timezone.now().date() - timedelta(days=3),
        )
    created = deal_health_sweep()
    assert created == 2  # inactivity + high risk for the same deal
    assert deal_health_sweep() == 0  # de-duplicated while unread
    with tenant_context(org_a.org.pk):
        kinds = set(Notification.objects.values_list("kind", flat=True))
    assert kinds == {"deal_inactive", "ai_high_risk"}
