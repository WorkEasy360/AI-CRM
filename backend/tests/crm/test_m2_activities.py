"""Milestone 2 activities: subtasks, RRULE recurrence (events expanded, tasks rolled forward), bulk
reassign, "My day", notes and files on activities, and events for every mutation."""

from __future__ import annotations

import datetime as dt

import pytest
from django.utils import timezone

from apps.activities.models import Activity
from apps.audit.models import AuditEvent
from tests.m2_helpers import captured_events, in_org

pytestmark = pytest.mark.django_db


def _task(client, **extra):
    body = {"kind": "task", "title": "Follow up", **extra}
    return client.post("/api/v1/activities/", body, format="json")


def test_subtasks_belong_to_a_task_one_level_deep(org_a, owner_client):
    parent = _task(owner_client, title="Prepare proposal").json()
    child = _task(owner_client, title="Pricing sheet", parent_id=parent["id"])
    assert child.status_code == 201, child.content
    assert child.json()["parent_id"] == parent["id"]
    grandchild = _task(owner_client, title="Too deep", parent_id=child.json()["id"])
    assert grandchild.status_code == 400
    meeting_child = owner_client.post(
        "/api/v1/activities/",
        {"kind": "meeting", "title": "x", "start_at": timezone.now().isoformat(), "parent_id": parent["id"]},
        format="json",
    )
    assert meeting_child.status_code == 400
    listed = owner_client.get(f"/api/v1/activities/{parent['id']}/").json()
    assert listed["subtask_count"] == 1 and listed["subtasks_done"] == 0
    owner_client.post(f"/api/v1/activities/{child.json()['id']}/complete/")
    assert owner_client.get(f"/api/v1/activities/{parent['id']}/").json()["subtasks_done"] == 1
    subs = owner_client.get(f"/api/v1/activities/?parent={parent['id']}").json()["results"]
    assert [s["title"] for s in subs] == ["Pricing sheet"]
    top = owner_client.get("/api/v1/activities/?top_level=true").json()["results"]
    assert {a["title"] for a in top} == {"Prepare proposal"}


def test_recurrence_rules_are_validated(owner_client):
    start = (timezone.now() + dt.timedelta(days=1)).isoformat()
    ok = _task(owner_client, start_at=start, recurrence="RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4")
    assert ok.status_code == 201 and ok.json()["recurrence"] == "FREQ=WEEKLY;BYDAY=MO;COUNT=4"
    for bad in [
        "FREQ=HOURLY",
        "FREQ=DAILY;DTSTART=20260101",
        "FREQ=DAILY;COUNT=5000",
        "nonsense",
        "FREQ=DAILY;COUNT=2;UNTIL=20270101T000000Z",
    ]:
        assert _task(owner_client, start_at=start, recurrence=bad).status_code == 400, bad
    assert _task(owner_client, recurrence="FREQ=DAILY").status_code == 400  # needs a due date
    call = owner_client.post(
        "/api/v1/activities/",
        {"kind": "call", "title": "c", "direction": "outbound", "start_at": start, "recurrence": "FREQ=DAILY"},
        format="json",
    )
    assert call.status_code == 400


def test_completing_a_recurring_task_creates_the_next_one(org_a, owner_client):
    due = timezone.now().replace(microsecond=0) + dt.timedelta(hours=2)
    task = _task(
        owner_client, title="Weekly pipeline review", start_at=due.isoformat(), recurrence="FREQ=WEEKLY;COUNT=3"
    ).json()
    with captured_events() as events:
        owner_client.post(f"/api/v1/activities/{task['id']}/complete/")
    with in_org(org_a):
        series = list(Activity.objects.filter(series_id=task["series_id"]).order_by("start_at"))
    assert len(series) == 2
    assert series[0].status == "completed" and series[0].recurrence == ""
    assert series[1].status == "open" and series[1].start_at == due + dt.timedelta(weeks=1)
    assert {e.change for e in events if e.entity_type == "activity"} >= {"updated", "created"}
    owner_client.post(f"/api/v1/activities/{series[1].pk}/complete/")
    with in_org(org_a):
        third = Activity.objects.filter(series_id=task["series_id"], status="open").get()
    owner_client.post(f"/api/v1/activities/{third.pk}/complete/")
    with in_org(org_a):  # COUNT=3: the series ends
        assert Activity.objects.filter(series_id=task["series_id"]).count() == 3
        assert not Activity.objects.filter(series_id=task["series_id"], status="open").exists()


def test_calendar_expands_recurring_events(owner_client):
    start = dt.datetime(2026, 11, 2, 9, 0, tzinfo=dt.UTC)  # a Monday
    resp = owner_client.post(
        "/api/v1/activities/",
        {
            "kind": "meeting",
            "title": "Stand-up",
            "start_at": start.isoformat(),
            "end_at": (start + dt.timedelta(minutes=15)).isoformat(),
            "recurrence": "FREQ=WEEKLY;BYDAY=MO,WE",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    cal = owner_client.get("/api/v1/activities/calendar/?from=2026-11-09&to=2026-11-15").json()["results"]
    starts = [c["start_at"][:10] for c in cal if c["title"] == "Stand-up"]
    assert starts == ["2026-11-09", "2026-11-11"]
    assert all(c["occurrence_of"] == resp.json()["id"] for c in cal if c["title"] == "Stand-up")
    assert cal[0]["end_at"].startswith("2026-11-09T09:15")


def test_bulk_reassign(org_a, owner_client, make_member, client_for, crm):
    rep = make_member(org_a, "sales_rep")
    other = make_member(org_a, "sales_rep")
    acts = [crm.make_activity(org_a, owner=rep, title=f"T{i}") for i in range(3)]
    with captured_events() as events:
        resp = owner_client.post(
            "/api/v1/activities/bulk/",
            {"ids": [str(a.pk) for a in acts], "action": "reassign", "payload": {"owner_id": str(other.pk)}},
            format="json",
        )
    assert resp.status_code == 200 and resp.json()["affected"] == 3, resp.content
    assert sum(1 for e in events if e.change == "reassigned") == 3
    with in_org(org_a):
        assert set(Activity.objects.filter(pk__in=[a.pk for a in acts]).values_list("owner_id", flat=True)) == {
            other.pk
        }
        assert Activity.objects.get(pk=acts[0].pk).version == 2
        audit = AuditEvent.objects.get(action="activities.bulk_reassign")
        assert len(audit.metadata["ids"]) == 3
    # a rep has no bulk permission at all
    rep_client = client_for(rep.user, rep)
    assert (
        rep_client.post(
            "/api/v1/activities/bulk/", {"ids": [str(acts[0].pk)], "action": "complete"}, format="json"
        ).status_code
        == 403
    )


def test_bulk_refuses_out_of_scope_ids(org_a, org_b, owner_client, crm):
    mine = crm.make_activity(org_a)
    foreign = crm.make_activity(org_b)
    resp = owner_client.post(
        "/api/v1/activities/bulk/", {"ids": [str(mine.pk), str(foreign.pk)], "action": "complete"}, format="json"
    )
    assert resp.status_code == 400 and resp.json()["type"] == "bulk_out_of_scope"
    with in_org(org_a):
        assert Activity.objects.get(pk=mine.pk).status == "open"


def test_my_day(org_a, owner_client, make_member, crm):
    now = timezone.now()
    me = org_a.owner_membership
    crm.make_activity(org_a, owner=me, title="Overdue", start_at=now - dt.timedelta(days=2))
    crm.make_activity(org_a, owner=me, title="No date", start_at=None)
    today_noon = now.replace(hour=12, minute=0, second=0, microsecond=0)
    crm.make_activity(
        org_a,
        owner=me,
        kind="call",
        title="Call Ada",
        start_at=today_noon,
        direction="outbound",
        end_at=today_noon + dt.timedelta(minutes=15),
    )
    someone = make_member(org_a, "sales_rep")
    crm.make_activity(org_a, owner=someone, title="Not mine", start_at=today_noon)
    day = owner_client.get("/api/v1/activities/my-day/?tz=UTC").json()
    assert [a["title"] for a in day["overdue"]] == ["Overdue"]
    assert [a["title"] for a in day["calls"]] == ["Call Ada"]
    assert [a["title"] for a in day["no_date"]] == ["No date"]
    assert all(a["title"] != "Not mine" for bucket in ("tasks", "events", "calls") for a in day[bucket])


def test_notes_and_files_attach_to_activities(org_a, owner_client, crm):
    activity = crm.make_activity(org_a)
    with captured_events() as events:
        note = owner_client.post(
            "/api/v1/notes/",
            {"entity_type": "activity", "entity_id": str(activity.pk), "body": "Agenda"},
            format="json",
        )
    assert note.status_code == 201, note.content
    assert any(e.entity_type == "note" and e.related == (("activity", str(activity.pk)),) for e in events)
    listed = owner_client.get(f"/api/v1/notes/?entity_type=activity&entity_id={activity.pk}").json()["results"]
    assert listed[0]["body"] == "Agenda"
