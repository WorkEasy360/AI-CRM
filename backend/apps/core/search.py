"""Migration helpers for trigger-maintained ``search_vector`` columns (ADR-0011).

The trigger runs inside PostgreSQL so imports, bulk updates and the ORM all keep the vector in sync.
Columns are declared in code; the SQL is assembled from a fixed template with identifiers only (no
user input reaches these strings).
"""

from __future__ import annotations

import re

from django.db import migrations

_IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")


def _ident(name: str) -> str:
    if not _IDENT.match(name):
        raise ValueError(f"Invalid SQL identifier: {name!r}")
    return name


def search_vector_trigger(table: str, weights: dict[str, list[str]]) -> migrations.RunSQL:
    """``weights`` maps 'A'/'B'/'C'/'D' to column lists. Emails are also split on @ and . so that
    ``john`` finds ``john@example.com``."""
    table = _ident(table)
    parts = []
    for weight, columns in weights.items():
        if weight not in {"A", "B", "C", "D"}:
            raise ValueError(weight)
        exprs = []
        for col in columns:
            col = _ident(col)
            exprs.append(f"coalesce(NEW.{col}, '')")
            if "email" in col:
                exprs.append(f"regexp_replace(coalesce(NEW.{col}, ''), '[@.]', ' ', 'g')")
        joined = " || ' ' || ".join(exprs)
        parts.append(f"setweight(to_tsvector('simple', {joined}), '{weight}')")
    vector = " || ".join(parts)
    fn = f"{table}_search_update"
    forward = f"""
CREATE OR REPLACE FUNCTION {fn}() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := {vector};
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS {fn}_trg ON {table};
CREATE TRIGGER {fn}_trg BEFORE INSERT OR UPDATE ON {table}
    FOR EACH ROW EXECUTE FUNCTION {fn}();
"""
    backward = f"""
DROP TRIGGER IF EXISTS {fn}_trg ON {table};
DROP FUNCTION IF EXISTS {fn}();
"""
    return migrations.RunSQL(forward, reverse_sql=backward)
