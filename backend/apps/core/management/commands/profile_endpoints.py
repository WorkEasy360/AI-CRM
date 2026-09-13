"""Query profile of the interactive endpoints for one member (development/staging only).

Runs each hot endpoint in-process through Django's test client as the given user, reporting the number
of SQL statements, total SQL time and wall time, and printing ``EXPLAIN (ANALYZE, BUFFERS)`` for the
slowest statements. Use it after seeding (``seed_loadtest``) to catch N+1 patterns and missing indexes
before a load test does.

    python manage.py profile_endpoints --email owner@lt-large-0.example.com --explain 3
"""

from __future__ import annotations

import json
import time
from typing import Any

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext

from apps.accounts.models import Membership, User
from apps.accounts.session import pick_default_membership
from apps.core.tenancy.context import TenantContext, bind_context, tenant_context
from apps.core.tenancy.middleware import ACTIVE_MEMBERSHIP_KEY

ENDPOINTS: list[tuple[str, str]] = [
    ("session", "/api/v1/session/"),
    ("dashboard", "/api/v1/dashboard/?period=30d"),
    ("dashboard_365d", "/api/v1/dashboard/?period=365d"),
    ("board", "/api/v1/deals/board/"),
    ("deals_list", "/api/v1/deals/?limit=50"),
    ("deals_count", "/api/v1/deals/count/"),
    ("contacts_list", "/api/v1/contacts/?limit=50"),
    ("contacts_count", "/api/v1/contacts/count/"),
    ("contacts_sorted_company", "/api/v1/contacts/?limit=50&sort=company"),
    ("companies_list", "/api/v1/companies/?limit=50"),
    ("products_list", "/api/v1/products/?limit=50"),
    ("search", "/api/v1/search/?q=ada"),
    ("search_email_domain", "/api/v1/search/?q=example"),
    ("timeline", "/api/v1/timeline/?limit=50"),
    ("audit_events", "/api/v1/audit-events/?limit=50"),
    # Sales operations / communication / AI (Phases 3-5)
    ("activities_list", "/api/v1/activities/?limit=50"),
    ("activities_calendar", "/api/v1/activities/calendar/?from=2026-09-01&to=2026-10-12"),
    ("activities_summary", "/api/v1/activities/summary/?owner=me"),
    ("forecast_month", "/api/v1/forecast/?period=month"),
    ("forecast_owner", "/api/v1/forecast/?period=quarter&group_by=owner"),
    ("notifications", "/api/v1/notifications/?unread=true"),
    ("email_history_mine", "/api/v1/email/messages/?limit=50"),
]


class Command(BaseCommand):
    help = "Profile the SQL behind the interactive endpoints for one member."

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True)
        parser.add_argument("--explain", type=int, default=0, help="EXPLAIN ANALYZE the N slowest statements")
        parser.add_argument("--json", action="store_true", help="Emit a JSON report instead of a table")
        parser.add_argument("--repeat", type=int, default=2, help="Runs per endpoint (the first warms caches)")

    def handle(self, *args, **options):
        if settings.ENVIRONMENT == "production":
            raise CommandError("Never profile against production.")
        user = User.objects.filter(email=options["email"]).first()
        if user is None:
            raise CommandError("Unknown user.")
        # RLS hides membership rows until the user half of the database context is bound (as the
        # tenant middleware does for a request).
        with bind_context(TenantContext(organization_id=None, user_id=user.pk)):
            membership: Membership | None = pick_default_membership(user)
        if membership is None:
            raise CommandError("User has no active membership.")
        client = Client(HTTP_HOST="localhost")
        client.force_login(user)
        session = client.session
        session[ACTIVE_MEMBERSHIP_KEY] = str(membership.pk)
        session.save()

        report: list[dict[str, Any]] = []
        slowest: list[tuple[float, str]] = []
        for name, path in ENDPOINTS:
            for run in range(options["repeat"]):
                with CaptureQueriesContext(connection) as ctx:
                    start = time.perf_counter()
                    resp = client.get(path)
                    wall_ms = (time.perf_counter() - start) * 1000
                sql_ms = sum(float(q["time"]) for q in ctx.captured_queries) * 1000
                if run == options["repeat"] - 1:
                    report.append(
                        {
                            "endpoint": name,
                            "status": resp.status_code,
                            "queries": len(ctx.captured_queries),
                            "sql_ms": round(sql_ms, 1),
                            "wall_ms": round(wall_ms, 1),
                        }
                    )
                    for q in ctx.captured_queries:
                        slowest.append((float(q["time"]) * 1000, q["sql"]))
        if options["json"]:
            self.stdout.write(json.dumps(report, indent=2))
        else:
            self.stdout.write(f"{'endpoint':28} {'status':>6} {'queries':>8} {'sql_ms':>8} {'wall_ms':>8}")
            for row in report:
                self.stdout.write(
                    f"{row['endpoint']:28} {row['status']:>6} {row['queries']:>8} "
                    f"{row['sql_ms']:>8} {row['wall_ms']:>8}"
                )
        if options["explain"]:
            slowest.sort(key=lambda item: item[0], reverse=True)
            seen: set[str] = set()
            shown = 0
            for ms, sql in slowest:
                if sql in seen or sql.startswith(("SAVEPOINT", "RELEASE", "SELECT set_config")):
                    continue
                seen.add(sql)
                self.stdout.write(f"\n--- {ms:.1f} ms\n{sql}\n")
                if "SELECT" in sql.upper()[:20]:
                    # Explain inside the member's tenant context so RLS policies see the same settings
                    # the request did (outside it every policy is false and plans return zero rows).
                    with (
                        tenant_context(
                            membership.organization_id, user_id=user.pk, membership_id=membership.pk, reason="profile"
                        ),
                        connection.cursor() as cur,
                    ):
                        try:
                            cur.execute("EXPLAIN (ANALYZE, BUFFERS) " + sql)
                            for line in cur.fetchall():
                                self.stdout.write("    " + line[0])
                        except Exception as exc:
                            self.stdout.write(f"    (explain failed: {type(exc).__name__})")
                shown += 1
                if shown >= options["explain"]:
                    break
