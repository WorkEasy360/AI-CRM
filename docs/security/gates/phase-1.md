# SECURITY GATE — Phase 1 (Secure Foundation)

Date: 2026-09-13. Scope: repository scaffold, backend foundation (`core`, `accounts`, `authz`, `teams`, `audit`, `privacy` interfaces), security middleware, CI, containers, frontend shell. Reviewer: implementing engineer (self-review against `docs/security/threat-model.md`); product-owner approval pending.

## 1. Attack surface introduced

| Surface | Endpoints / components |
|---|---|
| Authentication (django-allauth headless, `/_allauth/browser/v1/`) | signup, email verification, login, logout, password request/reset/change, re-authentication, TOTP + recovery codes, WebAuthn endpoints (no UI yet), session list/revoke |
| Session & organizations | `GET /api/v1/session/`, `POST /api/v1/session/switch-organization/`, `POST /api/v1/organizations/`, `GET/PATCH /api/v1/organizations/current/` |
| Membership administration | `/api/v1/members/` (list, retrieve, role, disable, enable), `/api/v1/invitations/` (list, create, revoke, public preview, authenticated accept), `/api/v1/teams/` (+ members add/remove), `/api/v1/roles/`, `/api/v1/audit-events/` |
| Operational | `/health/`, `/ready/` (public, no details), OpenAPI schema/docs (authenticated outside `DEBUG`) |
| Background | Celery app with `tenant_task` decorator (no tasks yet), Celery Beat scheduler tables |
| Frontend | Next.js pages for auth, onboarding, app shell, settings (organization, members, teams, security, audit log) |
| Build/CI | GitHub Actions workflows, backend/frontend Dockerfiles, Semgrep/gitleaks/bandit/pip-audit/Trivy/CodeQL configuration |

## 2. Threats identified

Register entries addressed in this phase: T1, T3, T4, T8, T9, T16, T17, T18, T19 (partial), T20, T22, T23, T24, T30. New entries discovered during implementation and added to the register: **T31** (stale sessions after privilege change), **T32** (identity-level RLS state), **T33** (transaction-local setting leakage), **T34** (`system_context` as in-process bypass), **T35** (MFA policy reported but not enforced). T31 and T35 were found by testing and fixed before this gate.

## 3. Security controls implemented

- **Tenant isolation**: `TenantModel` with immutable `organization_id`; fail-closed `TenantManager` (raises without context); `all_objects` usable only inside `system_context(reason)`; PostgreSQL RLS **enabled and forced** on all 9 tenant-owned tables (`accounts_organization`, `accounts_membership`, `accounts_invitation`, `authz_role`, `authz_rolepermission`, `teams_team`, `teams_teammembership`, `audit_auditevent`, test `testapp_widget`) keyed on transaction-local settings; `rls_check` command + test; dev/test DB role is non-superuser without `BYPASSRLS`.
- **Authentication**: Argon2id hashing; 12-char minimum + common/similarity validators; mandatory email verification; strict enumeration prevention; allauth rate limits (login 20/min/IP, 10 failures per 15 min per account, reset 3/min/key, signup 10/min/IP); session rotation on login, org create/switch, invitation accept; `session_salt` in the session auth hash for global revocation; allauth session tracking + purge; idle timeout 12 h, absolute 14 days; recent-auth (10 min) for sensitive actions; org-wide MFA enforcement; new-device notice; failed-login audit without credentials.
- **Authorization**: code-defined permission catalogue (no free-form strings); five system roles resolved from code; `check()`/`scope()` as the single decision point; DRF default permission is `DenyAll`; every route must declare `permission_map` (enforced by a test); detail lookups use the view scope then object-level `check()` (404 outside scope, 403 inside scope without rights); role invariants (last owner, self-change, admin cannot touch owners or grant owner); target sessions revoked on role change/disable.
- **CSRF / cookies**: Django CSRF on every state change (DRF `SessionAuthentication`), `HttpOnly` session cookie, `SameSite=Lax`, `__Host-` cookie names and `Secure` in production, CSRF cookie issued by the session endpoint.
- **Headers**: HSTS (ramped), nosniff, `X-Frame-Options: DENY`, referrer policy, COOP `same-origin`, CSP on API responses (`default-src 'none'; frame-ancestors 'none'; base-uri 'none'`), `Permissions-Policy`, `Cache-Control: no-store` on API/auth paths, request-id validation and echo.
- **Input handling**: JSON-only parser; explicit serializer field lists (Semgrep-enforced); tenant-scoped related fields (foreign ids from other orgs fail validation); currency/timezone/email validation; audit filter allowlist; 1 MB body cap, 500-field cap; UUID lookups only; format-suffix routes disabled.
- **Errors**: RFC 9457 problem details everywhere, JSON handlers for 400/403/404/500, no stack traces or ORM messages; production settings refuse to start with `DEBUG`, missing hosts/origins, or a weak `SECRET_KEY`.
- **Audit**: `audit.record()` from services with key-based redaction and value truncation; database trigger makes the table append-only for every role; tenant-scoped reads; admin API.
- **Rate limiting**: DRF throttles (anon 60/min, user 600/min, admin 120/min, sensitive 30/min, public invitation 20/min) on Redis; Nginx zones for `/_allauth/` and `/api/`.
- **Logging**: structlog JSON in production with a redaction processor; request log has method/path/status/duration/user/org/ip only.
- **Secrets & supply chain**: settings read only from the environment; `.env` git-ignored; gitleaks config with a Keel token rule; pinned lock file (`uv.lock`); pip-audit; Dependabot-ready CI; SBOM job; non-root, read-only-friendly container without pip/ensurepip; dependency review notes in `docs/plan/phase-1-plan.md`.
- **Static analysis**: ruff (security rules `S`, Django `DJ`, bugbear), mypy (clean), bandit, Semgrep `p/django` + `p/python` + eight project rules (unscoped managers, raw SQL, `mark_safe`, `fields="__all__"`, `csrf_exempt`, `AllowAny`, `eval/exec`, unsafe deserialisation).

## 4. Authorization checks implemented

`RequirePermissions` on every tenant view; `IsAuthenticatedUser` on the three reviewed org-less routes; public invitation preview is the only `AllowAny` action (throttled, token-hashed lookup). Service functions re-check on the loaded object. Bulk/export/AI permissions are already in the catalogue for later phases.

## 5. Tenant-isolation checks

- ORM: `test_manager_requires_context`, `test_save_sets_organization_and_scopes_reads`, `test_organization_is_immutable`, `test_cross_tenant_create_rejected`, `test_unscoped_manager_requires_system_context`, `test_context_is_restored_after_nested_binding`.
- Database: `test_rls_blocks_raw_sql_without_context`, `test_rls_blocks_raw_insert_for_other_org`, `test_membership_visible_to_its_user_without_org`, `test_every_tenant_table_has_forced_rls`.
- API (router-generated): every viewset probed from another organization's owner on every detail route (`GET/PATCH/DELETE/POST` actions) → 404, list excludes foreign ids; registry test forces a factory for each new tenant resource.
- Payload smuggling: `organization_id`, `owner_id`, foreign `manager_id`, tampered session membership.
- Background: `test_tenant_task_requires_organization`.

## 6. Input-validation checks

Weak password rejected; invalid currency/timezone rejected; malicious HTML/SQL strings stored and returned as JSON only; oversized JSON rejected; unsupported media type rejected; malformed/sequential ids → 404; request-id header sanitised; invitation token length capped; audit date filters validated.

## 7. Tests written

| Suite | Tests |
|---|---|
| `tests/authz_matrix/test_matrix.py` (role × ownership × operation, admin routes × role, anonymous, no-org) | 60 |
| `tests/authz_matrix/test_route_coverage.py` | 1 |
| `tests/tenant_isolation/test_context_and_rls.py` | 12 |
| `tests/tenant_isolation/test_generated.py` | 6 |
| `tests/tenant_isolation/test_payload_smuggling.py` | 4 |
| `tests/accounts/test_auth_flows.py` | 12 |
| `tests/accounts/test_members_and_invitations.py` | 13 |
| `tests/accounts/test_mfa_enforcement.py` | 1 |
| `tests/security_regression/test_headers_csrf_errors.py` | 11 |
| `tests/audit/test_audit.py` | 4 |
| **Total backend** | **124, all passing** |
| Frontend vitest (CSRF cookie reader, `next` redirect validator, problem-details parser, invite dialog validation) | 32, all passing (4 files); Playwright smoke spec written, self-skips without `E2E_BASE_URL` (Phase 6 wires it to staging) |

## 8. Remaining vulnerabilities and gaps

| # | Item | Severity | Status |
|---|---|---|---|
| G1 | WebAuthn/passkeys: backend endpoints enabled, no frontend enrolment UI yet | Low (planned) | Phase 2/3 UI work |
| G2 | Suspicious-login detection is IP + user-agent only (no impossible-travel) | Low | Phase 6 monitoring |
| G3 | Frontend route gating is client-side (cookie sessions cannot be verified server-side by Next.js through dev rewrites); the API is the enforcement point | Low | Documented; true edge gating arrives with the shared-origin reverse proxy in staging (Phase 6) |
| G4 | GitHub Actions are pinned by major version tags, not commit SHAs (ADR-0010 deviation) | Low | Accepted until Phase 6 when the repository is on GitHub and SHAs can be verified |
| G5 | `audit.login_failed` metadata stores the attempted email (PII) | Low | Needed for brute-force detection; retention policy in Phase 6 |
| G6 | Semgrep and gitleaks have no native Windows builds; run via Docker locally, natively in CI | Info | Documented |
| G7 | No WAF / edge rate limiting in dev; Nginx config written, not deployed | Info | Phase 6 |
| G8 | Custom roles, record sharing, field-level permissions | Not in scope | Designed, Phase 5+ |

No open Critical or High findings.

## 9. Dependencies introduced

Runtime: django 5.2.17, djangorestframework 3.18.1, django-allauth[mfa] 65.19.3 (+ fido2 2.2.1), django-csp 4.0, django-environ 0.14.0, django-redis 7.0.0, django-celery-beat 2.9.0, drf-spectacular 0.30.0, psycopg[binary,pool] 3.3.5, celery[redis] 5.6.3 (redis 6.4.0), structlog 26.1.0, gunicorn 26.2.0, argon2-cffi 25.1.0.
Dev: pytest 9.1.1, pytest-django 4.14.0, factory-boy 3.3.3, pytest-cov, freezegun, ruff 0.16.7, mypy 2.3.1, django-stubs 6.1.0, djangorestframework-stubs, bandit 1.9.4, semgrep 1.177.0, pip-audit 2.10.1.
Review notes: all are mainstream, actively maintained, permissively licensed; allauth was chosen to avoid hand-written auth/MFA crypto; no JWT library, no ORM extensions, no rich-text libraries.
Frontend runtime: next 15.5.25, react/react-dom 19.3.0, nine `@radix-ui/react-*` primitives, @tanstack/react-query 5.102.8, react-hook-form 7.88.0 + @hookform/resolvers 5.9.1, zod 4.6.2, lucide-react 1.45.0, class-variance-authority 0.7.1, clsx 2.1.1, tailwind-merge 3.6.0, qrcode 1.5.4 (TOTP QR rendered as an SVG path from the bit matrix; no HTML injection). Dev: typescript 5.9.3, tailwindcss 4.3.3, eslint 9.39.5 + eslint-config-next, vitest 4.1.11, @testing-library/*, @playwright/test 1.63.0, openapi-typescript 7.13.0. A `pnpm.overrides` entry forces postcss 8.5.28 over the vulnerable nested 8.4.31 pinned by Next. Justifications are in `frontend/README.md`; all versions exact-pinned with `pnpm-lock.yaml` committed.

## 10. Security scan results

| Scan | Result |
|---|---|
| pytest (124 tests incl. isolation, authz matrix, security regression) | pass |
| `manage.py rls_check` on migrated database | pass (9/9 tables forced RLS + policy) |
| `makemigrations --check` | in sync |
| ruff (lint + format) | 0 findings |
| mypy | 0 errors (96 files) |
| bandit | 0 findings (5 false positives annotated: audit action names and rate-limit strings flagged as passwords) |
| pip-audit | no known vulnerabilities |
| gitleaks (working tree, third-party trees excluded) | 0 leaks |
| Semgrep `p/django` + `p/python` + project rules | 0 findings (159 rules, 71 files); rerun after correcting the project rule paths: 0 findings |
| Trivy on `keel-backend` image (HIGH/CRITICAL, fixable) | run 1: 2 HIGH (msgpack 1.1.2, setuptools 70.3.0 vendored inside pip) → pip/ensurepip removed from the runtime stage; run 2 (fresh base pull): 12 Debian findings (3 CRITICAL, 9 HIGH, all with fixes) → `apt-get upgrade` added to the build; run 3: **0 findings** (Debian 13.7, 97 packages; all Python packages clean) |
| Frontend `pnpm audit --audit-level=high` | no known vulnerabilities |
| Frontend eslint (incl. `react/no-danger`, `no-eval`, `no-implied-eval`, `no-new-func`), `tsc --noEmit`, `pnpm build` | all pass (22 routes, standalone output); independent grep for `dangerouslySetInnerHTML`, `eval`, `innerHTML`, `localStorage`, `NEXT_PUBLIC_` in `src/`: none |
| Trivy on `keel-frontend` image (HIGH/CRITICAL, fixable) | run 1: 2 Alpine findings → `apk upgrade` added; run 2: Alpine clean, 11 findings (1 CRITICAL, 10 HIGH: tar, pacote, sigstore, ip-address, picomatch) all inside npm's bundled tree in the Node base image → npm/npx/corepack removed from the runtime stage; run 3: **0 findings**; container smoke test serves `/login` with HTTP 200 as uid 10001 |

## 11. Risks accepted

- Shared-schema tenancy with RLS as defense in depth (no per-tenant databases) — accepted in ADR-0002 for the target market.
- `system_context()` is an application-level bypass (T34); RLS protects against missing filters, not compromised application code. Mitigated by logging, reason strings, Semgrep confinement and code review.
- Action-tag pinning (G4) and client-side route gating (G3) as described above.

## 12. Safe to continue?

**Yes, pending product-owner approval.** No Critical or High finding is open in code, dependencies, secrets or container images. Two High/Critical classes were found and fixed during this gate (T31 stale sessions, T35 unenforced MFA policy) and four container-image vulnerability batches were fixed by removing package managers from runtime images and applying OS security updates at build time. Remaining items (G1–G8) are Low/Informational with owners and phases assigned.

Phase 2 (CRM core) does not start without the product owner's explicit approval of this document.
