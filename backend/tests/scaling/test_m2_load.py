"""Milestone 2 load tests.

* Kanban: a pipeline with 1,000 deals. The board API delivers every card of every column in one request
  well under a second; the web board renders columns windowed (``frontend/src/lib/use-windowed-list``),
  so the DOM holds only the visible cards.
* Sheet: windowed reads stay fast at the largest supported record count (1,000,000, the 360 edition's
  limit). Seeding a million rows takes minutes, so that test is opt-in: ``M2_LOAD=1 pytest
  tests/scaling/test_m2_load.py``. Its numbers are recorded in the Milestone 2 report.
"""

from __future__ import annotations

import os
import time

import pytest
from django.db import connection, transaction
from django.utils import timezone

from apps.deals.models import Deal, DealStageHistory
from apps.pipelines.models import PipelineStage
from tests.m2_helpers import in_org

pytestmark = pytest.mark.django_db

BOARD_BUDGET_SECONDS = 1.0


def _seed_deals(org, crm, n: int) -> None:
    pipeline = crm.make_pipeline(org)
    stages = [s for s in pipeline.stages.all() if s.kind == PipelineStage.Kind.OPEN]
    now = timezone.now()
    with in_org(org):
        deals = [
            Deal(
                organization_id=org.org.pk,
                name=f"Load deal {i}",
                pipeline=pipeline,
                stage=stages[i % len(stages)],
                owner=org.owner_membership,
                amount=1000 + i,
                amount_base=1000 + i,
                currency=org.org.base_currency,
                probability=stages[i % len(stages)].default_probability,
                stage_entered_at=now,
            )
            for i in range(n)
        ]
        Deal.objects.bulk_create(deals, batch_size=500)
        DealStageHistory.objects.bulk_create(
            [DealStageHistory(organization_id=org.org.pk, deal=d, to_stage=d.stage, changed_at=now) for d in deals],
            batch_size=500,
        )


def test_kanban_board_with_1000_deals_answers_under_a_second(org_a, owner_client, crm):
    _seed_deals(org_a, crm, 1000)
    owner_client.get("/api/v1/deals/board/?per_stage=10")  # warm the session and caches
    started = time.perf_counter()
    resp = owner_client.get("/api/v1/deals/board/?per_stage=300")
    elapsed = time.perf_counter() - started
    assert resp.status_code == 200
    board = resp.json()
    cards = sum(len(s["deals"]) for s in board["stages"])
    assert cards == 1000 and sum(s["deal_count"] for s in board["stages"]) == 1000
    assert not any(s["has_more"] for s in board["stages"])
    print(f"\n[m2-load] board with 1000 deals: {elapsed * 1000:.0f} ms, {len(resp.content) / 1024:.0f} KB")  # noqa: T201 - the load figures are the output of this test
    assert elapsed < BOARD_BUDGET_SECONDS, f"board took {elapsed:.2f}s"


SEED_CONTACTS_SQL = """
SET CONSTRAINTS ALL IMMEDIATE;
SELECT set_config('app.current_org', %(org)s, true);
INSERT INTO contacts_contact (
    id, organization_id, owner_id, created_by_id, updated_by_id, created_at, updated_at, version, custom_data,
    first_name, last_name, email, phone, job_title, source, address, description, lifecycle_stage,
    whatsapp_opt_in, archived_at
)
SELECT gen_random_uuid(), %(org)s::uuid, %(owner)s::uuid, %(owner)s::uuid, %(owner)s::uuid,
       now() - (g || ' seconds')::interval, now(), 1, '{}'::jsonb,
       'Load', 'Contact ' || g, 'load' || g || '@example.com', '', '', '', '{}'::jsonb, '', 'lead',
       false, NULL
FROM generate_series(%(start)s, %(stop)s) AS g;
"""


@pytest.mark.skipif(not os.environ.get("M2_LOAD"), reason="opt-in: seeds 1,000,000 contacts (set M2_LOAD=1)")
def test_sheet_window_at_one_million_records(org_a, owner_client, settings):
    total = int(os.environ.get("M2_LOAD_ROWS", "1000000"))
    chunk = 100_000
    started = time.perf_counter()
    for start in range(1, total + 1, chunk):
        with transaction.atomic(), connection.cursor() as cur:
            cur.execute(
                SEED_CONTACTS_SQL,
                {
                    "org": str(org_a.org.pk),
                    "owner": str(org_a.owner_membership.pk),
                    "start": start,
                    "stop": min(start + chunk - 1, total),
                },
            )
    with connection.cursor() as cur:
        cur.execute("ANALYZE contacts_contact")
    print(f"\n[m2-load] seeded {total} contacts in {time.perf_counter() - started:.0f}s")  # noqa: T201 - the load figures are the output of this test
    owner_client.get("/api/v1/records/contact/rows/?limit=10")  # warm
    timings = {}
    for label, offset in (("first window", 0), ("middle window", total // 2), ("last window", total - 200)):
        t0 = time.perf_counter()
        resp = owner_client.get(
            f"/api/v1/records/contact/rows/?offset={offset}&limit=200&columns=first_name,last_name,email"
        )
        timings[label] = time.perf_counter() - t0
        body = resp.json()
        assert resp.status_code == 200 and len(body["rows"]) == 200
        assert body["total"] == total and body["exact"]
    edit_ids = [r["id"] for r in owner_client.get("/api/v1/records/contact/rows/?limit=200").json()["rows"]]
    t0 = time.perf_counter()
    resp = owner_client.post(
        "/api/v1/records/contact/edits/",
        {"rows": [{"id": i, "version": 1, "values": {"job_title": "Bulk"}} for i in edit_ids]},
        format="json",
    )
    timings["200-row edit"] = time.perf_counter() - t0
    assert resp.json()["saved"] == 200
    for label, seconds in timings.items():
        print(f"[m2-load] {label}: {seconds * 1000:.0f} ms")  # noqa: T201 - the load figures are the output of this test
    assert timings["first window"] < 2.0 and timings["last window"] < 5.0
