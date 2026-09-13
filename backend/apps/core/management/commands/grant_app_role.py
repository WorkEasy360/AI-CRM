"""Production helper: grant the runtime role least-privilege access after migrations (run as crm_migrator)."""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import connection

APPEND_ONLY_TABLES = ("audit_auditevent",)


class Command(BaseCommand):
    help = "Grant DML to the runtime role and revoke UPDATE/DELETE on append-only tables."

    def add_arguments(self, parser):
        parser.add_argument("--role", default="crm_app")

    def handle(self, *args, **options):
        role = options["role"]
        if not role.replace("_", "").isalnum():
            raise ValueError("Invalid role name.")
        statements = [
            f"GRANT USAGE ON SCHEMA public TO {role}",
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {role}",
            f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {role}",
        ]
        statements += [f"REVOKE UPDATE, DELETE ON {t} FROM {role}" for t in APPEND_ONLY_TABLES]
        with connection.cursor() as cur:
            for stmt in statements:
                cur.execute(stmt)
        self.stdout.write(f"Granted runtime privileges to {role}.")
