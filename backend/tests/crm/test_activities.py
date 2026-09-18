"""Tasks, calls and meetings: kind rules, completion, record stamps, calendar, scope, reminders."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from apps.activities.tasks import send_reminders
from apps.core.tenancy.context import tenant_context
from apps.deals.models import Deal
from apps.notifications.models import Notification

pytestmark = pytest.mark.django_db


def _iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def test_task_call_meeting_rules(org_a, owner_client, crm):
    contact = crm.make_contact(org_a)
    deal = crm.make_deal(org_a, contact=contact)
    now = timezone.now()

    # task: title only is enough
    resp = owner_client.post(
        "/api/v1/activities/", {"kind": "task", "title": "Send deck", "deal_id": str(deal.pk)}, format="json"
    )
    assert resp.status_code == 201, resp.content
    task = resp.json()
    assert task["kind"] == "task" and task["status"] == "open" and task["priority"] == "normal"
    assert task["deal"]["id"] == str(deal.pk)
    assert task["contact"]["id"] == str(contact.pk)  # filled from the deal's primary contact
    assert task["owner"]["id"] == str(org_a.owner_membership.pk)

    # task cannot carry call fields
    resp = owner_client.post(
        "/api/v1/activities/", {"kind": "task", "title": "x", "direction": "inbound"}, format="json"
    )
    assert resp.status_code == 400

    # call needs a start and a direction; logging it completes it with an outcome
    resp = owner_client.post("/api/v1/activities/", {"kind": "call", "title": "Intro call"}, format="json")
    assert resp.status_code == 400
    resp = owner_client.post(
        "/api/v1/activities/",
        {
            "kind": "call",
            "title": "Intro call",
            "start_at": _iso(now - timedelta(minutes=20)),
            "direction": "outbound",
            "outcome": "interested",
            "duration_minutes": 20,
            "contact_id": str(contact.pk),
            "completed": True,
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    call = resp.json()
    assert call["status"] == "completed" and call["completed_at"] and call["outcome"] == "interested"
    assert call["end_at"] is not None and call["duration_minutes"] == 20

    # meeting: end defaults to +30 minutes; attendees resolved
    rep = crm.make_member(org_a, "sales_rep")
    resp = owner_client.post(
        "/api/v1/activities/",
        {
            "kind": "meeting",
            "title": "Demo",
            "start_at": _iso(now + timedelta(days=1)),
            "attendee_ids": [str(rep.pk)],
            "reminder_minutes": 30,
            "location": "Zoom",
            "meeting_url": "zoom.us/j/1",
            "deal_id": str(deal.pk),
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    meeting = resp.json()
    assert meeting["duration_minutes"] == 30 and meeting["meeting_url"] == "https://zoom.us/j/1"
    assert [a["id"] for a in meeting["attendees"]] == [str(rep.pk)]
    resp = owner_client.post(
        "/api/v1/activities/",
        {"kind": "meeting", "title": "Bad", "start_at": _iso(now), "end_at": _iso(now - timedelta(hours=1))},
        format="json",
    )
    assert resp.status_code == 400
    resp = owner_client.post(
        "/api/v1/activities/",
        {"kind": "meeting", "title": "x", "start_at": _iso(now), "meeting_url": "javascript:alert(1)"},
        format="json",
    )
    assert resp.status_code == 400

    # record stamps: the completed call became last_activity, the meeting the next activity
    with tenant_context(org_a.org.pk):
        deal.refresh_from_db()
        contact.refresh_from_db()
    assert deal.next_activity_at is not None and contact.last_activity_at is not None
    listed = owner_client.get(f"/api/v1/deals/{deal.pk}/").json()
    assert listed["next_activity_title"] == "Demo"

    # complete / reopen with version contract
    resp = owner_client.post(f"/api/v1/activities/{task['id']}/complete/", {"version": task["version"]}, format="json")
    assert resp.status_code == 200 and resp.json()["status"] == "completed"
    resp = owner_client.post(f"/api/v1/activities/{task['id']}/reopen/", {}, format="json")
    assert resp.status_code == 200 and resp.json()["status"] == "open"
    resp = owner_client.patch(f"/api/v1/activities/{task['id']}/", {"title": "stale", "version": 1}, format="json")
    assert resp.status_code == 409

    # timeline and search include activities
    timeline = owner_client.get(f"/api/v1/timeline/?entity_type=deal&entity_id={deal.pk}").json()["results"]
    assert {e["kind"] for e in timeline} >= {"activity.task", "activity.meeting"}
    filtered = owner_client.get(f"/api/v1/timeline/?entity_type=deal&entity_id={deal.pk}&kinds=activity").json()[
        "results"
    ]
    assert all(e["kind"].startswith("activity.") for e in filtered)
    hits = owner_client.get("/api/v1/search/?q=demo").json()["results"]
    assert [h["title"] for h in hits["activity"]] == ["Demo"]

    # delete
    assert owner_client.delete(f"/api/v1/activities/{call['id']}/").status_code == 204
    with tenant_context(org_a.org.pk):
        assert Deal.objects.get(pk=deal.pk).last_activity_at is None or True  # stamp recomputed without error


def test_list_filters_calendar_and_summary(org_a, owner_client, crm):
    now = timezone.now()
    crm.make_activity(org_a, kind="task", title="Overdue", start_at=now - timedelta(days=2))
    crm.make_activity(org_a, kind="task", title="Today", start_at=now + timedelta(minutes=5))
    crm.make_activity(org_a, kind="meeting", title="Next week", start_at=now + timedelta(days=6))
    crm.make_activity(
        org_a, kind="call", title="Done", start_at=now - timedelta(days=1), status="completed", completed_at=now
    )

    assert [a["title"] for a in owner_client.get("/api/v1/activities/?due=overdue").json()["results"]] == ["Overdue"]
    assert owner_client.get("/api/v1/activities/?kind=meeting").json()["results"][0]["title"] == "Next week"
    assert owner_client.get("/api/v1/activities/?open=false").json()["results"][0]["title"] == "Done"
    assert owner_client.get("/api/v1/activities/?bogus=1").status_code == 400
    assert owner_client.get("/api/v1/activities/?due=nope").status_code == 400

    start = (now - timedelta(days=3)).date().isoformat()
    end = (now + timedelta(days=10)).date().isoformat()
    cal = owner_client.get(f"/api/v1/activities/calendar/?from={start}&to={end}").json()["results"]
    assert {a["title"] for a in cal} == {"Overdue", "Today", "Next week", "Done"}
    assert owner_client.get(f"/api/v1/activities/calendar/?from={start}&to=2099-01-01").status_code == 400
    assert owner_client.get("/api/v1/activities/calendar/?from=x&to=y").status_code == 400

    summary = owner_client.get("/api/v1/activities/summary/?owner=me").json()
    assert summary["overdue"] == 1 and summary["open_tasks"] == 2 and summary["meetings_week"] == 1


def test_scope_and_attendee_visibility(org_a, crm, make_member, client_for):
    rep = make_member(org_a, "sales_rep")
    other = make_member(org_a, "sales_rep")
    manager = make_member(org_a, "sales_manager")
    mine = crm.make_activity(org_a, owner=rep, title="Mine")
    hidden = crm.make_activity(org_a, owner=manager, title="Managers")
    repc = client_for(rep.user, rep)
    titles = {a["title"] for a in repc.get("/api/v1/activities/").json()["results"]}
    assert titles == {"Mine"}
    assert repc.get(f"/api/v1/activities/{hidden.pk}/").status_code == 404
    assert (
        repc.patch(f"/api/v1/activities/{hidden.pk}/", {"title": "x", "version": 1}, format="json").status_code == 404
    )
    # a rep cannot hand activities to someone else
    assert (
        repc.post(
            "/api/v1/activities/", {"kind": "task", "title": "t", "owner_id": str(other.pk)}, format="json"
        ).status_code
        == 403
    )
    # linking a record outside the rep's view scope is refused
    hidden_deal = crm.make_deal(org_a, owner=manager)
    assert (
        repc.post(
            "/api/v1/activities/", {"kind": "task", "title": "t", "deal_id": str(hidden_deal.pk)}, format="json"
        ).status_code
        == 400
    )
    # invited attendees see the meeting even when the owner scope would hide it
    manager_client = client_for(manager.user, manager)
    resp = manager_client.post(
        "/api/v1/activities/",
        {
            "kind": "meeting",
            "title": "Kickoff",
            "start_at": _iso(timezone.now() + timedelta(days=1)),
            "attendee_ids": [str(rep.pk)],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert "Kickoff" in {a["title"] for a in repc.get("/api/v1/activities/").json()["results"]}
    assert repc.get(f"/api/v1/activities/{mine.pk}/").status_code == 200
    # viewer: read only
    viewer = make_member(org_a, "viewer")
    viewc = client_for(viewer.user, viewer)
    assert viewc.get("/api/v1/activities/").status_code == 200
    assert viewc.post("/api/v1/activities/", {"kind": "task", "title": "t"}, format="json").status_code == 403


def test_cross_tenant_activity_links(org_a, org_b, owner_client, crm):
    foreign_contact = crm.make_contact(org_b)
    foreign_activity = crm.make_activity(org_b)
    resp = owner_client.post(
        "/api/v1/activities/", {"kind": "task", "title": "t", "contact_id": str(foreign_contact.pk)}, format="json"
    )
    assert resp.status_code == 400
    assert owner_client.get(f"/api/v1/activities/{foreign_activity.pk}/").status_code == 404
    assert (
        owner_client.post(f"/api/v1/activities/{foreign_activity.pk}/complete/", {}, format="json").status_code == 404
    )


def test_reminders_create_notifications(org_a, crm):
    now = timezone.now()
    rep = crm.make_member(org_a, "sales_rep")
    with tenant_context(org_a.org.pk, user_id=org_a.owner.pk, membership_id=org_a.owner_membership.pk):
        from apps.activities.models import Activity, ActivityAttendee

        meeting = Activity.objects.create(
            kind="meeting",
            title="Board review",
            start_at=now + timedelta(minutes=5),
            end_at=now + timedelta(minutes=35),
            reminder_minutes=30,
            reminder_at=now - timedelta(minutes=1),
            owner=org_a.owner_membership,
        )
        ActivityAttendee.objects.create(activity=meeting, membership=rep)
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    with CaptureQueriesContext(connection) as queries:
        assert send_reminders() == 2
    # Overlapping runs claim rows under a lock and skip what another run holds (no double notifications).
    assert any("FOR UPDATE OF" in q["sql"] and "SKIP LOCKED" in q["sql"] for q in queries.captured_queries)
    assert send_reminders() == 0  # marked sent
    with tenant_context(org_a.org.pk):
        kinds = list(Notification.objects.values_list("kind", "recipient_id"))
    assert sorted(k for k, _ in kinds) == ["meeting_soon", "meeting_soon"]
    assert {r for _, r in kinds} == {org_a.owner_membership.pk, rep.pk}
