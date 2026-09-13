# API Documentation

The API is described by an OpenAPI 3 document generated from the code (`drf-spectacular`), so it never
drifts from the implementation.

- Generate: `cd backend && uv run python manage.py spectacular --file ../frontend/openapi.json --format openapi-json`
- Browse (dev only): http://localhost:8000/api/v1/docs/ (Swagger UI) — requires login outside `DEBUG`.
- Auth endpoints are provided by django-allauth headless; in dev their spec is served at
  http://localhost:8000/_allauth/openapi.html.
- The frontend generates TypeScript types from `frontend/openapi.json` (`pnpm gen:api`); CI regenerates and
  fails on drift.

Conventions (see `docs/architecture/api-architecture.md`): same-origin cookie sessions + `X-CSRFToken`,
RFC 9457 problem details for every error, cursor pagination (`?cursor=&limit=`; max 200), UUID ids,
`404` for anything outside the caller's tenant/scope, `403` with `type: "reauth_required"` when a
sensitive action needs a fresh authentication (`POST /_allauth/browser/v1/auth/reauthenticate`).

## Phase 1 surface

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/session/` | authenticated (sets CSRF cookie) |
| POST | `/api/v1/session/switch-organization/` | authenticated, own membership only |
| POST | `/api/v1/organizations/` | authenticated |
| GET / PATCH | `/api/v1/organizations/current/` | `org.view` / `org.update` (+ recent auth) |
| GET | `/api/v1/roles/` | `roles.view` |
| GET | `/api/v1/members/`, `/api/v1/members/{id}/` | `members.view` |
| PATCH | `/api/v1/members/{id}/role/` | `members.update_role` (+ recent auth, role invariants) |
| POST | `/api/v1/members/{id}/disable/`, `.../enable/` | `members.disable` (+ recent auth) |
| GET / POST | `/api/v1/invitations/` | `members.invite` |
| DELETE | `/api/v1/invitations/{id}/` | `members.invite` |
| GET | `/api/v1/invitations/preview/?token=` | public, throttled |
| POST | `/api/v1/invitations/accept/` | authenticated, email must match |
| GET / POST | `/api/v1/teams/` | `teams.view` / `teams.manage` |
| GET / PATCH / DELETE | `/api/v1/teams/{id}/` | `teams.view` / `teams.manage` |
| GET | `/api/v1/teams/{id}/members/` | `teams.view` |
| POST | `/api/v1/teams/{id}/members/add/`, `.../remove/` | `teams.manage` |
| GET | `/api/v1/audit-events/`, `/api/v1/audit-events/{id}/` | `audit.view` |
| GET | `/health/`, `/ready/` | public, no details |

## Phase 2 surface (CRM core)

Conventions for every record collection (`contacts`, `companies`, `products`, `deals`): cursor pagination
(`?cursor=&limit=`), allowlisted filters (`?owner=me|<membership_id>`, entity-specific keys, `?custom.<key>=`),
allowlisted sorts (`?sort=-created_at`), text search (`?q=`), `?archived=true` for archived records; unknown
filter or sort keys answer 400. Writes to a record require the client's last-seen `version` (`If-Match: "<n>"`
header or `version` in the body); a stale version answers `409 version_conflict`, a missing one `428`.

| Method | Path | Permission |
|---|---|---|
| GET / POST | `/api/v1/{contacts,companies,products,deals}/` | `<module>.view` / `<module>.create` |
| GET / PATCH / DELETE (archive) | `/api/v1/{module}/{id}/` | `<module>.view` / `<module>.update` / `<module>.delete` |
| POST | `/api/v1/{module}/{id}/restore/` | `<module>.delete` |
| PUT | `/api/v1/{module}/{id}/tags/` | `<module>.update` |
| GET | `/api/v1/{module}/count/`, `/api/v1/{contacts,companies}/stats/` | `<module>.view` |
| POST | `/api/v1/{contacts,companies,deals}/bulk/` (`archive`, `restore`, `reassign`, `add_tag`, `remove_tag`; max 500 ids; refuses the whole request if any id is outside the actor's scope) | `<module>.bulk_update` |
| GET | `/api/v1/deals/board/?pipeline=` | `deals.view` |
| POST | `/api/v1/deals/{id}/stage/` (`{stage_id, version, lost_reason?}`; row-locked, versioned, historised) | `deals.change_stage` |
| GET | `/api/v1/deals/{id}/history/`, `.../products/`, `.../contacts/` | `deals.view` |
| POST / PATCH / POST | `/api/v1/deals/{id}/products/add/`, `.../products/{line_id}/`, `.../products/{line_id}/remove/` | `deals.update` |
| POST | `/api/v1/deals/{id}/contacts/add/`, `.../contacts/remove/` | `deals.update` |
| GET / POST | `/api/v1/pipelines/` | `pipelines.view` / `pipelines.manage` |
| GET / PATCH / DELETE | `/api/v1/pipelines/{id}/` | `pipelines.view` / `pipelines.manage` |
| POST | `/api/v1/pipelines/{id}/stages/`, `.../stages/reorder/` | `pipelines.manage` |
| GET / PATCH / DELETE | `/api/v1/stages/{id}/` | `pipelines.view` / `pipelines.manage` |
| GET / POST | `/api/v1/custom-fields/` | `customfields.view` / `customfields.manage` |
| GET / PATCH / DELETE, POST `.../restore/` | `/api/v1/custom-fields/{id}/` | `customfields.view` / `customfields.manage` |
| GET / POST | `/api/v1/tags/`; GET / PATCH / DELETE `/api/v1/tags/{id}/` | `tags.view` / `tags.manage` |
| GET / POST | `/api/v1/notes/?entity_type=&entity_id=` | `notes.view` (record must be visible) / `notes.create` |
| GET / PATCH / DELETE | `/api/v1/notes/{id}/` | `notes.view` / `notes.update` / `notes.delete` (author scope) |
| GET | `/api/v1/timeline/?entity_type=&entity_id=` | `notes.view` (record must be visible) |
| GET | `/api/v1/search/?q=&types=&limit=` | `search.use` (results pass `authz.scope()` per entity) |
| GET / POST (multipart `file`) | `/api/v1/imports/{contacts,companies,products}/` | `<module>.import` |
| GET, GET `.../preview/`, POST `.../start/` | `/api/v1/imports/{entity}/{id}/` (requester only) | `<module>.import` |
| GET / POST | `/api/v1/exports/{contacts,companies,products,deals}/` (POST requires recent authentication) | `<module>.export` |
| GET, GET `.../download/` | `/api/v1/exports/{entity}/{id}/` (requester only; CSV attachment, formula-neutralised, 24 h expiry) | `<module>.export` |
