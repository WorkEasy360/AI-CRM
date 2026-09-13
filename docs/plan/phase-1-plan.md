# Phase 1 — Secure Foundation: Implementation Plan

**Status (2026-09-13): implemented.** Backend deliverables 1.1–1.2 and documentation 1.4 are complete with 124 passing tests; the frontend shell (1.3) is built under `frontend/`. Deviations from the plan: the custom `user_session` table was replaced by allauth's `usersessions` app plus a per-user `session_salt` in the session auth hash (stronger revocation, less custom code); organization creation is a separate authenticated step after sign-up rather than part of the sign-up form (supports invited users joining existing organizations). Gate report: `docs/security/gates/phase-1.md`.

Goal: a deployable skeleton where a user can sign up, verify email, create an organization, enable MFA, invite teammates with roles, switch organizations, see an audit log, and where every tenant-isolation and authorization mechanism the later phases rely on already exists and is tested.

## 1. Deliverables

### 1.1 Repository and tooling
- `git init`, monorepo layout from `docs/00-phase0-overview.md` §D, `.editorconfig`, `.gitignore`, `.gitleaks.toml`, pre-commit (ruff, gitleaks, eslint).
- `docker-compose.yml`: postgres:16 (with `crm_app`/`crm_migrator` roles created by init script), redis:7, backend, worker, beat, frontend, mailpit, minio.
- `Makefile`: `dev`, `test`, `lint`, `typecheck`, `security` (semgrep + bandit + pip-audit + gitleaks), `rls-check`.
- GitHub Actions `ci.yml` with the jobs from `docs/architecture/infrastructure.md` §3 (CodeQL, Trivy included from day one).

### 1.2 Backend (`backend/`)
Python 3.13, Django 5.2.x (latest patch at implementation time), DRF, PostgreSQL 16.

| App | Contents |
|---|---|
| `config` | settings split (`base/dev/test/prod`), env parsing, production assertions (`DEBUG` off, HTTPS settings, secrets present), logging config with redaction filter, Celery app, URL root, problem-details exception handler |
| `core` | `TenantModel`, `TenantManager`, `UnscopedManager`, `tenancy` (ContextVar, `Actor`, `tenant_context()`, `TenantMiddleware`, `SET LOCAL`), RLS migration operations (`EnableRLS`, `CreateTenantPolicy`) and metaclass hook, `@tenant_task` decorator, base exceptions, `RequestIDMiddleware`, `SecurityHeadersMiddleware`, throttles, pagination classes, common validators |
| `accounts` | `User` (custom, email login, citext), `Organization`, `Membership`, `Invitation`, `UserSession`; allauth headless configuration (signup, verification, login, logout, password reset/change, TOTP MFA, recovery codes, WebAuthn endpoints enabled), organization switch endpoint with session rotation, recent-auth check, suspicious-login notice, session listing and revocation endpoints |
| `authz` | permission catalogue module, `Role`, `RolePermission`, system role fixtures (Owner, Admin, Sales Manager, Sales Rep, Viewer), `check()`, `scope()`, `RequirePermissions`, route-coverage test helper |
| `teams` | `Team`, `TeamMembership`, CRUD for admins, used by `scope()` |
| `audit` | `AuditEvent`, `record()`, redaction, admin list endpoint with filters, migration granting `crm_app` INSERT/SELECT only |
| `privacy` (design only) | model stubs and interfaces for export/deletion so later phases plug in |
| `tests/` | factories, `tenant_isolation/` (router-driven generator), `authz_matrix/`, `security_regression/` (CSRF, headers, mass assignment, enumeration, rate limits), RLS coverage test, raw-SQL RLS test as `crm_app` |

API surface (all under `/api/v1/` unless noted):

```
/auth/*                                   allauth headless (signup, login, logout, verify, reset, mfa, webauthn)
GET  /session/                            current user, active org, permissions, mfa state
POST /session/switch-organization/        {organization_id} → validates membership, rotates session
GET  /session/sessions/  DELETE /session/sessions/{id}/  POST /session/sessions/revoke-all/
POST /organizations/                      create org (first org created at signup)
GET/PATCH /organizations/current/         org settings (name, base_currency, timezone, require_mfa)
GET  /members/  PATCH /members/{id}/role/  POST /members/{id}/disable/  POST /members/{id}/enable/
POST /invitations/  GET /invitations/  DELETE /invitations/{id}/  POST /invitations/accept/ (public, token)
GET/POST /teams/  GET/PATCH/DELETE /teams/{id}/  POST /teams/{id}/members/  DELETE /teams/{id}/members/{membership_id}/
GET  /roles/                              system roles + permission listing
GET  /audit-events/                       admin only, filters: actor, action, resource, date
GET  /schema/  /docs/                     OpenAPI (authenticated in prod)
GET  /health/  /ready/                    unauthenticated, no details
```

### 1.3 Frontend (`frontend/`)
Next.js 15 (App Router), TypeScript strict, Tailwind CSS 4 with original design tokens, Radix primitives, TanStack Query, react-hook-form + zod, lucide icons, vitest + Testing Library, Playwright.

- Design system foundation: colour scale (original palette, light/dark), type scale, spacing, radius, elevation; core components (Button, Input, Select, Dialog, Sheet/Drawer, Toast, Table shell, Avatar, Badge, EmptyState, Skeleton).
- Auth pages: sign up, verify email, log in (with MFA step), forgot/reset password, accept invitation.
- App shell: left navigation (Dashboard, Pipeline, Contacts, Companies, Products, Activities, Reports), top bar (global search placeholder, quick add, notifications placeholder, org switcher, user menu), AI Copilot drawer placeholder, responsive collapse for tablet/mobile.
- Settings: organization profile, members (invite, role change, disable), teams, security (MFA enrolment, sessions), audit log viewer.
- API client: same-origin fetch with `credentials: "include"`, CSRF header from cookie, problem-details parsing, generated types from OpenAPI, 401 → login redirect with validated `next`.
- CSP nonce middleware; no `NEXT_PUBLIC_` secrets.

### 1.4 Documentation
README (setup), `docs/environment-setup.md`, `docs/api/README.md` (how to read OpenAPI), updated ERD for Phase 1 tables, ADR updates, Phase 1 Security Gate report.

## 2. Work breakdown (ordered)

1. Scaffold repo, Docker dev environment, CI skeleton, pre-commit, lock files.
2. `config` settings + production assertions + logging + problem-details handler + security middleware + tests.
3. `core.tenancy`: ContextVar, `Actor`, `TenantModel`, managers, `SET LOCAL`, RLS migration operations, `@tenant_task`; unit tests including "no context → no rows" at ORM and SQL level.
4. `accounts`: models, allauth headless config, session endpoints, org switch, invitation flow, recent-auth; tests (flows, rate limits, enumeration, rotation, revocation).
5. `authz`: catalogue, roles, `check`/`scope`, DRF integration, route-coverage test; matrix tests.
6. `teams`, `audit` (with append-only grants) and admin endpoints.
7. Cross-cutting generators: router-driven cross-tenant tests, authz matrix, security regression suite.
8. OpenAPI generation + frontend type generation in CI.
9. Frontend design tokens + primitives + auth pages + app shell + settings pages + Playwright smoke (signup → verify → login → invite → accept → switch org).
10. Security scans in CI green; Phase 1 Security Gate report.

## 3. Dependencies to introduce (with review notes)

| Package | Purpose | Review |
|---|---|---|
| `django` 5.2.x | framework | LTS, security releases tracked |
| `djangorestframework` | API | mature, widely audited |
| `psycopg[binary,pool]` 3 | PostgreSQL driver | official |
| `django-allauth[mfa]` | auth flows, MFA, WebAuthn | actively maintained; headless mode; reduces custom crypto |
| `django-csp` | CSP headers | maintained by Mozilla |
| `django-environ` | env parsing | small, stable |
| `celery[redis]`, `django-celery-beat` | background jobs/scheduling | standard |
| `django-redis` | cache backend | standard |
| `drf-spectacular` | OpenAPI | standard |
| `argon2-cffi` | password hashing | required by Django's Argon2 hasher |
| `structlog` | structured logging | stable |
| `gunicorn` | WSGI server | standard |
| `pytest`, `pytest-django`, `factory-boy`, `pytest-cov`, `freezegun` | tests | dev only |
| `ruff`, `mypy`, `django-stubs`, `djangorestframework-stubs`, `bandit`, `semgrep`, `pip-audit` | quality/security | dev only |
| Frontend: `next`, `react`, `typescript`, `tailwindcss`, `@radix-ui/*`, `@tanstack/react-query`, `react-hook-form`, `zod`, `lucide-react`, `vitest`, `@testing-library/react`, `@playwright/test`, `eslint`, `openapi-typescript` | UI | all mainstream, MIT/ISC; icons are an original open set, not the reference product's |

Deliberately not introduced: JWT libraries, django-tenants, Elasticsearch, Kubernetes manifests, any rich-text editor.

## 4. Phase 1 test list (must pass)

- Tenancy: `TenantContextMissing` raised; `organization_id` immutable; `SET LOCAL` applied; RLS coverage; raw SQL as `crm_app` returns 0 rows without context; Celery task without org rejected.
- Auth: signup/verify/login/logout; unverified login blocked; wrong password lockout; per-IP throttle; reset token single-use and expiring; sessions revoked on password change/role change/disable; `cycle_key()` on login and org switch; recent-auth required for role change; MFA enrol/verify/recovery; generic responses for enumeration paths.
- Authz: matrix per role × endpoint × (own/team/other/other-org); last-owner protection; self role change denied; owner injection ignored; route coverage.
- Audit: events written for all listed actions; app role cannot update/delete; redaction of secrets in metadata.
- Security regression: CSRF missing header → 403; security headers present; CSP present; problem-details on errors with no internals; oversized JSON → 413; `next` open redirect blocked; health endpoint leaks nothing.
- Frontend: unit tests for auth forms and API client; Playwright smoke path.

## 5. Phase 1 Security Gate (expected content)

Attack surface: auth endpoints, session/org switch, member/role/team/invitation management, audit viewer, health endpoints, frontend auth pages. Threats: T1, T3, T4, T8, T9, T16, T17, T18, T20, T22, T23, T24, T30. Controls and tests as listed above. Expected accepted risks: no WAF in dev/staging until Phase 6; AV scanning not yet relevant; SSO not available.
