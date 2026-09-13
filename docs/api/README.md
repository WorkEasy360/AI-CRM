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
| POST | `/api/v1/session/bootstrap/` | authenticated; no body. Creates the caller's personal workspace if they belong to no organization and activates their default membership (idempotent, row-locked) |
| GET | `/api/v1/dashboard/` | `dashboards.view`; every aggregate is limited by the caller's own `contacts.view` / `deals.view` scope |
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

## Phase 3-5 surface (sales operations, communication, AI)

| Method | Path | Permission |
|---|---|---|
| GET / POST | `/api/v1/activities/` (filters: `kind`, `status`, `priority`, `owner`, `contact`, `company`, `deal`, `from`, `to`, `due=overdue|today|week|upcoming|none`, `open`, `q`, `sort`) | `activities.view` / `activities.create` |
| GET / PATCH / DELETE | `/api/v1/activities/{id}/` (`version` required on PATCH) | `activities.view` / `activities.update` / `activities.delete` |
| POST | `/api/v1/activities/{id}/complete/`, `.../reopen/` | `activities.update` |
| GET | `/api/v1/activities/calendar/?from=&to=` (max 62 days), `/api/v1/activities/summary/` | `activities.view` (attendees always see their meetings) |
| GET | `/api/v1/contacts/duplicates/?email=&phone=&first_name=&last_name=`, `/api/v1/companies/duplicates/?name=&website=` | `<module>.view` (scoped; never confirms hidden records) |
| PATCH | `/api/v1/{contacts,companies}/{id}/` with `lifecycle_stage` (lead, prospect, qualified, customer, inactive) | `<module>.update` (historised; a closed-won deal promotes its contacts and company automatically) |
| GET | `/api/v1/deals/{id}/insights/` (rules-based risk, next best action, lead score) | `deals.view` |
| GET | `/api/v1/timeline/?entity_type=&entity_id=&kinds=note,activity,email,whatsapp,deal,lifecycle,record` | `notes.view` |
| GET | `/api/v1/forecast/?period=month|quarter|custom&from=&to=&pipeline=&group_by=stage|owner|pipeline|team` | `reports.view` (inside the caller's `deals.view` scope) |
| GET | `/api/v1/notifications/?unread=`; POST `.../read/`, `.../read-all/`; GET `.../unread-count/` | `notifications.view` (recipient only) |
| GET / PATCH | `/api/v1/notifications/preferences/` | `notifications.view` |
| GET | `/api/v1/email/accounts/`, `.../providers/` | `email.view` |
| POST | `/api/v1/email/accounts/connect/` (`{provider}` → `authorization_url`, PKCE; recent auth) ; GET `.../callback/` | `email.connect` |
| DELETE | `/api/v1/email/accounts/{id}/` | `email.connect` |
| GET / POST / PATCH / DELETE | `/api/v1/email/templates/`; GET `.../{id}/render/?contact=&deal=` | `email.view` / `email.templates_manage` |
| GET | `/api/v1/email/messages/?contact=|company=|deal=` (record must be visible) | `email.view` |
| POST | `/api/v1/email/messages/` (JSON or multipart with `attachments`; queued, sent by the notifications worker) | `email.send` |
| GET / POST / DELETE | `/api/v1/whatsapp/account/` (POST/DELETE need recent auth; the token is stored encrypted and never returned) | `whatsapp.view` / `whatsapp.manage` |
| GET / POST / DELETE | `/api/v1/whatsapp/templates/` | `whatsapp.view` / `whatsapp.manage` |
| GET | `/api/v1/whatsapp/messages/?contact=|deal=`, `.../window/?contact=` (24-hour customer-service window) | `whatsapp.view` |
| POST | `/api/v1/whatsapp/messages/` (`text` inside the window, `template` with recorded opt-in) | `whatsapp.send` |
| GET / POST | `/api/v1/whatsapp/webhook/` | public; verify-token handshake, `X-Hub-Signature-256` HMAC on every POST |
| POST | `/api/v1/ai/deals/{id}/summary/` (cached per deal version) | `ai.copilot.use` + `deals.view` |
| POST | `/api/v1/ai/follow-up/` (`{entity_type, entity_id, tone, channel}`), `/api/v1/ai/email/` (`{purpose, tone, operation, text?}`) | `ai.copilot.use` + record visible |
| GET | `/api/v1/ai/contacts/{id}/score/` (rules-based, with reasons) | `ai.scores.view` |
| GET | `/api/v1/ai/usage/` | `ai.settings.manage` |

AI endpoints answer `429 ai_quota_user` / `ai_quota_org` when budgets are exhausted, `422 ai_refused` when the model
declines, and `503 ai_unavailable` when the provider is down or not configured (no API key). They return drafts only;
nothing is sent without a separate, authorized send request.

Deal payloads (`/api/v1/deals/`, `.../{id}/`, `.../board/`) carry `primary_contact.phone` and
`primary_contact.whatsapp_opt_in` next to `id`, `name` and `email`. Both are read from the contact row at request
time (nothing is copied onto the deal) and are `null` unless the caller's `contacts.view` scope covers that contact,
so the deal-header WhatsApp action never discloses more than the contact record would.
