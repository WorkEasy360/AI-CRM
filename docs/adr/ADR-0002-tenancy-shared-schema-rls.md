# ADR-0002 — Shared schema tenancy with `organization_id` and PostgreSQL RLS

**Status:** Accepted (2026-09-12); implemented in Phase 1

## Context
Tenant isolation is the most important security property. Options: shared schema with a tenant column, schema-per-tenant, database-per-tenant. Target market is many small/medium organizations.

## Decision
Every tenant-owned table carries `organization_id`. The ORM enforces scoping through a mandatory tenant context (managers refuse to run without it). PostgreSQL Row Level Security is enabled and forced on every tenant-owned table, keyed on a transaction-local setting (`SET LOCAL app.current_org`) established by middleware and by the Celery task wrapper. The runtime DB role cannot bypass RLS; migrations run under a separate owner role.

## Consequences
- Two independent layers must both fail for a cross-tenant leak to occur.
- Missing context fails closed (no rows) rather than open.
- Works with transaction-mode connection pooling.
- All queries pay a cheap `organization_id` predicate; indexes lead with `organization_id`.
- Cross-tenant analytics for operators must use the audited unscoped path.
- Database-per-tenant for specific enterprise customers remains possible later via connection routing because the data model already carries the tenant key.
