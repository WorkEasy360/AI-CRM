# Multi-Tenancy Strategy

Decision (ADR-0002): **shared database, shared schema, `organization_id` on every tenant-owned row, PostgreSQL Row Level Security as defense in depth.**

Rejected alternatives:
- *Schema-per-tenant*: migration fan-out, connection-pool fragmentation, painful cross-tenant admin reporting, and no real security gain over RLS for a small-business CRM with potentially thousands of tenants.
- *Database-per-tenant*: only justified for regulated enterprise customers; can be added later for specific tenants by routing at the connection layer because the model already carries `organization_id`.

## 1. Tenant context

A request's tenant is never taken from the client. It is derived server-side:

1. `SessionMiddleware` authenticates the user from the `HttpOnly` session cookie.
2. `TenantMiddleware` loads the user's **active membership** (`session["active_membership_id"]`, validated on every request against the `membership` table: must belong to the user, be `active`, and the organization must be `active`).
3. The resolved `Actor` (`user`, `membership`, `organization`, `role`, permission set, `request_id`, `ip`) is put on `request.actor` **and** in a `contextvars.ContextVar` (`core.tenancy.current_actor`).
4. If a request carries an `organization_id`, `owner_id`, `role` or similar in the body or query string that conflicts with the resolved context, it is ignored for security decisions and logged as a `tenant.mismatch_attempt` audit event.

Switching organizations (a user can belong to several) is an explicit endpoint that re-validates membership and **rotates the session key**.

## 2. ORM enforcement (application layer)

```python
class TenantModel(models.Model):
    organization = models.ForeignKey("accounts.Organization", on_delete=models.CASCADE, editable=False)
    objects = TenantManager()          # scoped, raises without context
    all_objects = UnscopedManager()    # explicit, audited, system-only

    class Meta:
        abstract = True
```

- `TenantManager.get_queryset()` reads the current actor from the ContextVar and applies `.filter(organization_id=actor.organization_id)`. If no tenant context is set it raises `TenantContextMissing` instead of returning everything.
- `all_objects` is only importable from `apps.core.tenancy.system` and each use site must pass a `reason` that is written to the audit log (used by retention jobs, migrations, support tooling).
- `TenantModel.save()` sets `organization_id` from the context on create and refuses to change it afterwards (`ImmutableTenantError`).
- Foreign keys between tenant models are validated in services: the related object must resolve through the scoped manager (so a `contact_id` from another org fails as "not found", never as "forbidden", to avoid existence leaks).
- Serializers use `PrimaryKeyRelatedField(queryset=Model.objects...)` which is already tenant-scoped, so cross-tenant ids are rejected at validation time.
- A Semgrep rule fails CI on any `all_objects` usage outside the allowed package and on any raw SQL string interpolation.

## 3. PostgreSQL Row Level Security (database layer)

Every tenant-owned table gets:

```sql
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact
    USING (organization_id = current_setting('app.current_org', true)::uuid)
    WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid);
```

- Two database roles: `crm_app` (runtime; RLS applies; no DDL; `INSERT/SELECT` only on `audit_event`, `deal_stage_history`) and `crm_migrator` (owner; runs migrations, retention purges, restore tests). The app never runs as the migrator.
- `ATOMIC_REQUESTS = True`. `TenantMiddleware` executes `SET LOCAL app.current_org = '<uuid>'` at the start of the request transaction. `SET LOCAL` is transaction-scoped, so it is safe with pgbouncer in transaction-pooling mode and cannot leak to the next request.
- Celery tasks wrap their body in `tenant_context(org_id)` which opens a transaction and issues the same `SET LOCAL`.
- If `app.current_org` is unset the policy evaluates to `NULL` and **no rows are visible**: a missing context fails closed at the database as well as in the ORM.
- Global tables (`user`, `role` with `organization_id IS NULL`, `ai_model_registry`) are not under the tenant policy; access to them is controlled in the service layer.
- Migrations generate RLS DDL through a `TenantModel` metaclass hook plus a test (`tests/tenant_isolation/test_rls_coverage.py`) that asserts every table with an `organization_id` column has `rowsecurity = true` and a policy. CI fails otherwise.
- `infra/scripts/rls-check.sql` is run against staging and production after each deploy.

### 3.1 As implemented (Phase 1)

- Three transaction-local settings: `app.current_org`, `app.current_user`, `app.system`. Policies are
  `organization_id = current_org OR <identity clause> OR app.system = 'on'`.
- Identity clauses: `accounts_membership` adds `user_id = current_user`; `accounts_organization` adds
  `id IN (SELECT organization_id FROM accounts_membership WHERE user_id = current_user)`; `authz_role` adds
  `organization_id IS NULL` (system roles). Everything else is strictly `organization_id = current_org`.
- `TenantMiddleware` opens one transaction per request, binds an **identity context** (`user_id` only) for any
  authenticated user, resolves the active membership under it, then nests the **tenant context**. On exit it
  restores the previous DB settings in a `finally` block, so nothing leaks to the next request on the connection.
- `system_context(reason)` sets `app.system = 'on'`. It is the only bypass; it is logged, requires a reason, and a
  Semgrep rule confines `all_objects` to reviewed modules (core, accounts services, privacy, tests, migrations).
- `manage.py rls_check` (also a test) asserts every table with an `organization_id` column, plus the organization
  table, has RLS enabled **and forced** with the `tenant_isolation` policy.
- Dev/test databases run as `crm_app` (non-superuser, `NOBYPASSRLS`); because RLS is *forced*, the policies apply
  even though `crm_app` owns the tables there. Production separates `crm_migrator` (owner) from `crm_app`.
- Related-object access after leaving a context (e.g. `membership.organization`) is hidden by RLS by design;
  services cache the related object before returning it.

## 4. Where tenant identity flows

| Path | How context is established |
|---|---|
| HTTP API | session → membership → `Actor` → ContextVar + `SET LOCAL` |
| Celery task | explicit `organization_id` + `actor_membership_id` args → `tenant_context()`; a task without them cannot touch tenant models |
| Celery Beat sweeps (reminders, retention) | iterate organizations with `all_objects` (audited), then enter `tenant_context(org)` per org |
| Management commands | require `--organization` or an explicit `--all-organizations --reason` flag |
| AI tool layer | tools receive the `Actor`; every tool body runs inside the same request context; no tool accepts an organization argument |
| Webhook inbound | endpoint secret → `webhook_endpoint` row (looked up by unscoped id under a system context) → its `organization_id` → `tenant_context()` |
| Search | queries built from scoped managers; results additionally pass `authz.scope()` |
| Export | job row carries `organization_id`; worker enters `tenant_context()` and re-applies `authz.scope()` for the requesting member |

## 5. Existence and timing leaks

- Cross-tenant lookups return `404`, identical in body and timing to a genuinely missing record.
- Uniqueness checks (email, slug) on global tables use constant-time responses and generic messages on public endpoints (signup, password reset, invitation acceptance).
- Sequential ids are not used for any tenant resource.
- Error responses never include SQL, model names or internal ids of other tenants.

## 6. Tests required (every phase)

- `test_cross_tenant_read_returns_404` for each list/detail endpoint, generated from the router so new endpoints are covered automatically.
- `test_cross_tenant_write_rejected` for each create/update/delete endpoint, including foreign-key smuggling (`company_id` from another org).
- `test_organization_id_in_payload_ignored`.
- `test_rls_blocks_without_context` executed with raw SQL as `crm_app`.
- `test_celery_task_requires_tenant_context`.
- `test_search_never_returns_foreign_rows`.
- `test_export_contains_only_scoped_rows`.
