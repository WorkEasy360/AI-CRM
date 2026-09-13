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
