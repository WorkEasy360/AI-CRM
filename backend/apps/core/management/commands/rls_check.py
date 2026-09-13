"""Verify that every table carrying an organization_id column has forced RLS and a tenant policy."""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import connection

from apps.core.rls import POLICY_NAME

TENANT_ROOT_TABLES = ("accounts_organization",)


def find_rls_gaps() -> list[str]:
    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                   EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = %s)
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
              AND (
                    EXISTS (SELECT 1 FROM pg_attribute a
                            WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
                    OR c.relname = ANY(%s)
              )
            ORDER BY c.relname
            """,
            [POLICY_NAME, list(TENANT_ROOT_TABLES)],
        )
        rows = cur.fetchall()
    gaps: list[str] = []
    for relname, enabled, forced, has_policy in rows:
        if not (enabled and forced and has_policy):
            gaps.append(f"{relname}: enabled={enabled} forced={forced} policy={has_policy}")
    return gaps


class Command(BaseCommand):
    help = "Fail if any tenant-owned table lacks forced Row Level Security with the tenant policy."

    def handle(self, *args, **options):
        gaps = find_rls_gaps()
        if gaps:
            for gap in gaps:
                self.stderr.write(f"RLS gap: {gap}")
            raise CommandError(f"{len(gaps)} table(s) without complete RLS protection.")
        self.stdout.write("RLS check passed: all tenant-owned tables are protected.")
