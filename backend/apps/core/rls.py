"""Helpers that generate PostgreSQL Row Level Security DDL for migrations.

Policies read transaction-local settings written by ``apps.core.tenancy.context.apply_db_context``:
- ``app.current_org``  the bound organization id
- ``app.current_user`` the authenticated user id (set before the organization is resolved)
- ``app.system``       ``'on'`` only inside ``system_context(reason=...)``

With no settings bound, every policy evaluates to NULL/false: no rows are visible or writable.
"""

from __future__ import annotations

from django.db import migrations

ORG_SETTING = "NULLIF(current_setting('app.current_org', true), '')::uuid"
USER_SETTING = "NULLIF(current_setting('app.current_user', true), '')::uuid"
SYSTEM_SETTING = "current_setting('app.system', true) = 'on'"

POLICY_NAME = "tenant_isolation"


def policy_condition(column: str = "organization_id", extra: str | None = None) -> str:
    cond = f"{column} = {ORG_SETTING}"
    if extra:
        cond = f"({cond}) OR ({extra})"
    return f"({cond}) OR ({SYSTEM_SETTING})"


def enable_rls(
    table: str, *, column: str = "organization_id", extra: str | None = None, condition: str | None = None
) -> migrations.RunSQL:
    """Return a migration operation enabling and forcing RLS with a tenant policy on ``table``.

    ``condition`` replaces the default ``column = current_org`` test for tables scoped indirectly.
    """
    cond = f"({condition}) OR ({SYSTEM_SETTING})" if condition else policy_condition(column, extra)
    forward = [
        f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;",
        f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;",
        f"CREATE POLICY {POLICY_NAME} ON {table} USING ({cond}) WITH CHECK ({cond});",
    ]
    backward = [
        f"DROP POLICY IF EXISTS {POLICY_NAME} ON {table};",
        f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY;",
        f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;",
    ]
    return migrations.RunSQL("\n".join(forward), reverse_sql="\n".join(backward))


def append_only_trigger(table: str) -> migrations.RunSQL:
    """Return a migration operation that rejects UPDATE/DELETE on ``table`` (audit-style tables)."""
    fn = f"{table}_append_only"
    forward = f"""
CREATE OR REPLACE FUNCTION {fn}() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '{table} is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER {fn}_trg BEFORE UPDATE OR DELETE ON {table}
    FOR EACH ROW EXECUTE FUNCTION {fn}();
"""
    backward = f"""
DROP TRIGGER IF EXISTS {fn}_trg ON {table};
DROP FUNCTION IF EXISTS {fn}();
"""
    return migrations.RunSQL(forward, reverse_sql=backward)
