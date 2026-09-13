# Authorization (RBAC) Model

Principle: **deny by default, enforced on the server, in one place.**

## 1. Concepts

- **Permission**: a string `module.action` from a code-defined catalogue (never user-defined strings).
- **Scope**: how far a permission reaches over records: `all` (whole organization), `team` (records owned by members of the actor's teams), `own` (records owned by the actor). Scopes are ordered `own < team < all`.
- **Role**: a named set of `(permission, scope)` pairs. Five system roles ship; custom roles reuse the same structure later.
- **Actor**: the resolved `(user, membership, organization, role, permissions)` for the request.
- **Ownership**: every core record has `owner_membership_id`. Ownership is the basis of `own`/`team` scopes.

## 2. Permission catalogue (Phase 1–3 subset)

```
org.view  org.update  org.delete  org.billing
members.view  members.invite  members.update_role  members.disable  members.remove
teams.view  teams.manage
roles.view  roles.manage                       (custom roles, future)
audit.view
settings.manage                                 (pipelines, stages, custom fields, tags, saved shared views)

contacts.view contacts.create contacts.update contacts.delete contacts.export contacts.import contacts.bulk_update
companies.*   (same actions)
products.*    (same actions; import/export for admins)
deals.view deals.create deals.update deals.delete deals.change_stage deals.reassign deals.export deals.import deals.bulk_update
activities.view activities.create activities.update activities.delete
notes.create notes.update notes.delete
dashboards.view dashboards.manage_own dashboards.manage_shared
reports.view reports.export
search.use
ai.copilot.use  ai.actions.confirm  ai.scores.view  ai.settings.manage
integrations.view integrations.manage
webhooks.manage
privacy.export_all  privacy.delete_data
```

Every DRF route must map to at least one permission through `permission_map`; a test enumerates the router and fails if any route lacks a mapping. Unknown permissions fail at import time.

## 3. System roles

| Permission group | Owner | Admin | Sales Manager | Sales Rep | Viewer |
|---|---|---|---|---|---|
| `org.update`, `settings.manage` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `org.delete`, `org.billing` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `members.view`, `teams.view`, `roles.view` (directory: names, roles, status) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `members.invite/update_role/disable/remove`, `teams.manage` | ✅ | ✅ (cannot change/disable Owner; cannot grant Owner) | ❌ | ❌ | ❌ |
| `audit.view` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `contacts/companies/deals .view` | all | all | all | team (falls back to own if no team) | all |
| `contacts/companies/deals .create` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `contacts/companies/deals .update` | all | all | all | own | ❌ |
| `deals.change_stage` | all | all | all | own | ❌ |
| `deals.reassign`, `*.bulk_update` | all | all | all | ❌ | ❌ |
| `*.delete` | all | all | all | own (archive only) | ❌ |
| `*.export` | all | all | all | ❌ | ❌ |
| `*.import` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `products.view` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `products.create/update/delete` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `activities.*` | all | all | all | own (+ view team) | view all |
| `notes.*` | all | all | all | own | ❌ |
| `dashboards.view` / `manage_own` | ✅ | ✅ | ✅ | ✅ | view only |
| `dashboards.manage_shared` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `reports.view` / `reports.export` | ✅/✅ | ✅/✅ | ✅/✅ | team/❌ | ✅/❌ |
| `ai.copilot.use`, `ai.scores.view` | ✅ | ✅ | ✅ | ✅ | scores only |
| `ai.actions.confirm` | ✅ | ✅ | ✅ | ✅ (own records) | ❌ |
| `ai.settings.manage`, `integrations.manage`, `webhooks.manage` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `privacy.*` | ✅ | ✅ (`export_all` only) | ❌ | ❌ | ❌ |

Invariants enforced in the service layer:
- There is always at least one active Owner; the last Owner cannot be demoted, disabled or removed.
- Only an Owner can grant Owner. Admins cannot modify Owners.
- A member cannot change their own role.
- Role changes rotate the target's sessions and emit `members.role_changed`.

## 4. Enforcement points

```python
# apps/authz/service.py
def check(actor: Actor, permission: str, obj: TenantModel | None = None) -> None:
    """Raise PermissionDenied unless actor holds `permission` with a scope that covers `obj`."""

def scope(actor: Actor, permission: str, queryset: QuerySet) -> QuerySet:
    """Narrow a tenant-scoped queryset to rows the actor may act on under `permission`."""
```

1. **View layer**: `RequirePermissions` DRF permission class reads `permission_map = {"list": "contacts.view", "create": "contacts.create", ...}` and calls `check()` with no object (a coarse gate).
2. **Selector layer**: every list query passes through `scope()` for the action's permission. Detail endpoints look the record up within the *view* scope and then `check()` the action's permission against the object: a record outside the actor's view scope answers 404 (no existence leak), a record the actor may view but not modify answers 403.
3. **Service layer**: every mutating service calls `check(actor, permission, obj)` again with the loaded object (object-level check) before writing. Services are the last line and are unit-tested independently of views.
4. **Field-level**: serializers expose different writable fields per permission (e.g. `owner_membership_id` writable only with `*.reassign`). Read-only fields are enforced server-side; mass assignment is prevented by explicit `fields` lists and `read_only_fields`.
5. **Bulk operations**: the service computes the scoped set first and refuses (400 with count) if the request references records outside it, rather than silently skipping.
6. **AI tools**: each tool declares its required permission; the tool runner calls `check()`/`scope()` with the human actor before executing.
7. **Background jobs**: tasks carry the actor's membership id and re-run `scope()`; a job never escalates beyond the requester's permissions.

## 5. Evolution path

- **Custom roles**: `role.organization_id NOT NULL`, editable `role_permission` rows; UI is a matrix over the catalogue; system roles stay immutable.
- **Record-level sharing**: `record_share (entity_type, entity_id, grantee_membership_id | team_id, level)` folded into `scope()` as a union.
- **Team hierarchy**: `team.parent_team_id`; `team` scope expands to descendants.
- **Field-level permissions**: `field_policy (role_id, entity_type, field_key, can_read, can_write)` consulted by serializers; custom fields participate through the same mechanism.

## 6. Tests

- Matrix test: for each (role × endpoint × scope case: own / team / other / other-org) assert expected status code. Generated from the role definitions so a change in the matrix must be accompanied by a change in the expected table.
- Escalation tests: rep changes own role; admin edits owner; last owner removal; owner_id injection; role change without recent auth.
- Route coverage test: every route has a `permission_map` entry.
