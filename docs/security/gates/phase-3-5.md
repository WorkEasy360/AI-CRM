# SECURITY GATE — Phases 3-5 (sales operations, communication, AI)

Date: 2026-09-13. Scope: activities (tasks, calls, meetings, calendar, reminders), contact/company lifecycle, duplicate detection, unified timeline, notifications, forecast, email (Gmail / Microsoft 365 OAuth), WhatsApp Business Cloud API, rules-based scoring / risk / next best action, AI summaries and drafts (Anthropic Claude), dashboard extensions, and the frontend for all of it. Reviewer: implementing engineer (self-review against `docs/security/threat-model.md` and `docs/architecture/ai-architecture.md`); product-owner approval pending. Phases 1 and 2 gates approved / pending as recorded in their documents.

## 1. Attack surface introduced

| Surface | Endpoints / components |
|---|---|
| Activities | `/api/v1/activities/` list/create, `/{id}/` retrieve/update/delete, `/{id}/complete/`, `/{id}/reopen/`, `/calendar/`, `/summary/` |
| Lifecycle / duplicates | `lifecycle_stage` on contact/company writes, `/contacts/duplicates/`, `/companies/duplicates/` |
| Deals | `/deals/{id}/insights/`, `probability_overridden`, `weighted_amount_base`, `risk_level` on every deal payload |
| Timeline | `?kinds=` filter; new providers (activities, lifecycle, emails, WhatsApp, audit-backed field changes) |
| Forecast | `/api/v1/forecast/` |
| Notifications | `/api/v1/notifications/` (+ `read`, `read-all`, `unread-count`), `/notifications/preferences/` |
| Email | `/email/accounts/` (+ `providers`, `connect`, `callback`, delete), `/email/templates/` (+ `render`), `/email/messages/` (JSON + multipart) |
| WhatsApp | `/whatsapp/account/`, `/whatsapp/templates/`, `/whatsapp/messages/` (+ `window`), **public** `/whatsapp/webhook/` (GET handshake, POST signed events) |
| AI | `/ai/deals/{id}/summary/`, `/ai/follow-up/`, `/ai/email/`, `/ai/contacts/{id}/score/`, `/ai/usage/` |
| Background | Celery: `activities.send_reminders` (beat, 60 s), `notifications.deal_health_sweep` (daily), `messaging.send_email_message`, `messaging.send_whatsapp_message`, `messaging.sync_email_accounts` (beat, 5 min) → `messaging.sync_email_account` |
| Database | 12 new tenant tables (activities ×2, lifecycle history, notifications ×2, messaging ×7, AI usage) with forced RLS; append-only trigger on lifecycle history; search-vector trigger on activities; new columns on contacts, companies, deals |
| External | Google OAuth / Gmail API, Microsoft identity platform / Graph, Meta WhatsApp Cloud API, Anthropic API — all outbound only, all behind adapters, all optional (unconfigured = feature shows "not configured") |
| Secrets | OAuth refresh/access tokens and the WhatsApp system-user token stored encrypted (Fernet, `MESSAGING_ENCRYPTION_KEYS`, rotation-ready); never serialized |

## 2. Threats identified

Existing register entries exercised again: T1 (IDOR/BOLA on every new relation), T8 (mass assignment), T10 (XSS through message bodies, AI output), T19 (unbounded queries), T20 (background jobs). New entries:

- **T40 — Unauthorized communication**: a member sends email/WhatsApp as someone else or to a contact they may not see. Controls: send always uses the caller's own mailbox (`EmailAccount.membership == actor.membership`); WhatsApp uses the organization account but the linked contact/deal/company must be inside the actor's view scope; `email.send` / `whatsapp.send` permissions; audit `email.queued/sent/failed`, `whatsapp.queued/sent/failed`.
- **T41 — Provider credential exposure**: tokens in API responses, logs or audit metadata. Controls: `*_enc` columns are never in any serializer; audit redaction covers `token`/`access_token`/`refresh_token`; the WhatsApp connect response never echoes the token; tests assert the token string is absent from responses and audit rows.
- **T42 — Webhook forgery / replay**: fake inbound WhatsApp messages or status updates. Controls: HMAC-SHA256 (`X-Hub-Signature-256`) with the app secret on every POST, constant-time compare, 512 KB body cap, verify-token handshake, account resolved by `phone_number_id` under a logged system context, message de-duplication by provider message id (replay is a no-op), payload item caps.
- **T43 — OAuth state / CSRF on the callback**: an attacker completes the flow for another user. Controls: state bound in cache to (membership, organization, provider) with a PKCE verifier, 10-minute TTL, consumed once; the callback runs as the authenticated session and refuses any state not issued to that membership.
- **T44 — WhatsApp policy violations**: free-form messages outside the 24-hour customer-service window, template messages without consent. Controls enforced server-side: `within_service_window` on text sends, `whatsapp_opt_in` required for templates, template names restricted to Meta's format.
- **T45 — Prompt injection (direct and indirect)**: notes, emails, WhatsApp messages or the user's own draft carry instructions. Controls: every retrieved text is escaped and wrapped in `<crm_data …>` blocks with an injection heuristic that marks `untrusted="high"` and truncates harder; the system prompt declares those blocks as data; a canary token is scrubbed from output; output is stripped of markup, control characters and length-capped; the model has no tools, no database access and returns drafts only.
- **T46 — Cross-tenant / cross-scope AI disclosure**: context assembled beyond the caller's rights. Controls: the record is resolved through `resolve_viewable` (404 outside scope) before any context is built; every related row is loaded through `authz.scope()`; summaries are cached under keys that include organization and membership; cross-tenant and out-of-scope tests answer 404, role tests answer 403.
- **T47 — AI cost exhaustion**: a user or tenant burns budget. Controls: per-user hourly request counter, per-organization daily token counter (Redis, fail-open only under `CACHE_FAIL_OPEN`), per-feature `max_tokens`, model routing (fast model for drafts, strong model for deal summaries), summary cache keyed by deal version + latest event, usage ledger with estimated cost visible to administrators, 429 with a clear message.
- **T48 — Notification spam / leakage**: notifications for records the recipient cannot see, duplicates. Controls: notifications are private to the recipient (queryset filtered before scope), de-duplicated per (kind, entity, 24 h, unread), preference-gated per channel, and only ever created by server-side rules (reminders, assignment, inactivity, high risk, customer replies).

## 3. Security controls implemented

- **Tenant isolation**: every new model inherits `TenantModel`; `rls_check` passes on the migrated database; foreign keys validate through tenant-scoped querysets; router-generated cross-tenant probes cover all 11 new viewsets (detail routes → 404, lists exclude foreign ids).
- **Authorization**: `permission_map` on every new view (route-coverage test); new permissions `notifications.view`, `email.view/send/connect/templates_manage`, `whatsapp.view/send/manage` added to the catalogue and role definitions (viewer: read-only; sales rep: send but not manage); activities follow own/team/all scopes on the owner, attendees see meetings they are invited to; linked records must be viewable to be linked; reassignment of activities needs the `all` update scope; lifecycle changes reuse the record's update authorization; AI endpoints require `ai.copilot.use` plus record visibility; usage is `ai.settings.manage`.
- **Public endpoint**: the WhatsApp webhook is the only unauthenticated route; it is listed in the reviewed `ALLOWED_PUBLIC` set of the route-coverage test and excluded from the Semgrep `AllowAny` rule by path; it authenticates every POST by signature.
- **Input validation**: explicit input serializers everywhere; kind-specific activity rules (no call fields on tasks, meetings end after they start, URLs http(s)-only, timezones from the IANA list, caps on duration/reminders/attendees); address lists capped at 20 recipients and validated; attachment allowlist (type, 10 MB, 5 per message); template placeholders counted and validated; lifecycle values from a closed set; timeline `kinds` capped; forecast periods bounded to 366 days and dimensions allowlisted; calendar ranges bounded to 62 days.
- **Concurrency**: `version` on activities (428/409 contract), stage moves unchanged; lifecycle writes go through the record's optimistic update.
- **Background processing**: sends run as `tenant_task`s after commit with the requester's membership; syncs and sweeps iterate organizations under an explicit system context and bind each tenant separately; reminders are marked sent in the same transaction (idempotent); all tasks have time limits and run on the existing queues.
- **Audit**: activities created/updated/completed/deleted; lifecycle changed; email connect started / account connected / disconnected / template created-updated-deleted / queued / sent / failed; WhatsApp account connected / disconnected / template changes / queued / sent / failed; `ai.deal_summary`, `ai.followup`, `ai.email_draft`, `ai.failed` (feature, model, token counts; never the prompt or the draft).
- **Frontend**: AI drafts are inserted into editable fields and never sent automatically; risk and scores are labelled "Rules-based"; the AI drawer stub was removed; no provider secret is ever rendered back.

## 4-6. Authorization, tenant-isolation and input-validation checks

See `tests/crm/test_activities.py`, `test_lifecycle.py`, `test_notifications.py`, `test_forecast.py`, `test_messaging.py`, `test_sales_workflow_e2e.py`, `tests/security_regression/test_ai_security.py`, the extended role matrix in `tests/authz_matrix/test_crm_matrix.py` (activities, notifications, forecast, email templates, WhatsApp templates, AI follow-up, AI usage per role) and the generated cross-tenant probes in `tests/tenant_isolation/test_generated.py`.

## 7. Tests written

| Suite | Coverage |
|---|---|
| `tests/crm/test_activities.py` | kind rules, completion/reopen with versions, record stamps, calendar/summary bounds, owner scope + attendee visibility, viewer read-only, cross-tenant links, reminder notifications |
| `tests/crm/test_lifecycle.py` | transitions historised + on the timeline, invalid stage, closed-won promotion (contacts, linked contacts, company; never demotes), probability override flag, scoped duplicate detection |
| `tests/crm/test_notifications.py` | recipient privacy, unread/read flows, preference gating and email channel, de-duplication, deal-assignment notification, daily health sweep |
| `tests/crm/test_forecast.py` | totals/weighted/committed/coverage, group-bys, custom period bounds, allowlisted dimensions, rep vs manager scope, tenant separation, dashboard extensions |
| `tests/crm/test_messaging.py` | OAuth connect/callback/disconnect (token never returned, encrypted at rest, stale state refused), send requires mailbox, scoped history (404 for a rep), provider failure recorded, audit without bodies, templates + render + role, inbox sync links replies to deals and notifies, WhatsApp connect/templates/consent/window rules, webhook signature/handshake/replay/status |
| `tests/security_regression/test_ai_security.py`, `test_ai_redteam.py` | permission + tenant scope (404/403), summary cache and single provider call, injection flagged/escaped/undeliverable, output sanitised, refusal/outage mapping without stack traces, email draft validation, per-user quota 429, rules-based insights labelling |
| `tests/crm/test_sales_workflow_e2e.py` | the full connected workflow: lead → qualify → company → deal → meeting → call → email → WhatsApp → AI summary/risk/follow-up → stage moves → closed won → customer → dashboard/forecast/timeline |

| Frontend (`pnpm test`, vitest) | 31 files / 149 tests (incl. deal-header quick actions): activities forms and calendar, quick actions, contacts/companies pages and forms (duplicate warning debounce, lifecycle changer), deal form (`defaults`, blank probability), kanban (probability, next step, risk dot, weighted totals), timeline kinds/filters, deal summary card, deal insights panel, dashboard tiles/links, forecast, shell/nav, notifications menu, messaging dialogs |

Gate-time results (2026-09-13, local): backend `uv run python -m pytest` 462 passed, 0 failed; `manage.py rls_check` passed; `ruff check` + `ruff format --check` clean; `mypy` clean (203 files); `bandit` 0 findings; `pip-audit --strict` no known vulnerabilities; `semgrep` (project rules) clean. Frontend `tsc --noEmit` clean, `eslint` clean, vitest 147/147, `next build` succeeds (31 routes), `pnpm audit --audit-level=high` no known vulnerabilities. Gitleaks and Trivy are not installed locally and run in CI only (`.github/workflows/ci.yml`).

## 8. Open items / residual risk

- Email inbound sync is polling-based (5 minutes) and matches replies by sender address and provider thread; Gmail push notifications (Pub/Sub) and Microsoft change notifications are a later optimisation.
- RAG over unstructured content uses PostgreSQL full-text retrieval only; pgvector embeddings are deferred until the PostgreSQL image ships the extension (no separate vector infrastructure is introduced).
- The AI copilot chat, natural-language analytics and proposed actions (ADR-0009) remain deferred; only summaries, drafts and rules-based insights ship.
- Predictive (trained) scoring remains gated behind the data conditions in `docs/architecture/ai-architecture.md`; every score in the product is labelled rules-based.
- Provider red-team of the live Anthropic adapter (as opposed to the fake provider used in tests) is to be run in staging with `ANTHROPIC_API_KEY` set.

## 9. Pre-staging validation (2026-09-13, local stack)

Run after Phases 3-5 were approved and before any new feature work. Everything below was executed on the
laptop reference environment (Docker Desktop PostgreSQL 16 / Redis 7, Django `runserver` with the fake
email/WhatsApp/AI providers, Celery `--pool=solo`, Next.js production standalone server). Numbers are the
final green run; see the commit message for the totals.

### Browser E2E (Playwright, Chromium, production build)

`frontend/tests/e2e/sales-workflow.spec.ts` (17 ordered steps) and `browser-behaviour.spec.ts` (8 scenarios)
plus the 3-test smoke spec: **28 / 28 passed** (Chromium, one worker, 1.8 min; last run 27 green plus the keyboard test green on its immediate rerun after a headless-focus tolerance fix in the test itself). The workflow covers login → pipeline → company → contact (with
WhatsApp consent) → deal → stage move → task → meeting → call → mailbox connect (sandbox OAuth) + email send →
WhatsApp connect + template + send from the deal header → signed inbound webhook (forged signature refused) +
free-text reply inside the service window → AI summary → AI follow-up + rules-based risk → closed won →
dashboard and forecast. The behaviour suite covers server-side session revocation (bounce to
`/login?next=`), TOTP enrolment / wrong code / correct code / disable, viewer denial in the UI and 403 from the
API, concurrent edits of one deal (second writer told, nothing overwritten), board loading skeleton and
retryable error, phone (390 px) and tablet (820 px) layouts with no horizontal overflow, and keyboard-only
sign-in, Ctrl+K search and quick-add.

**Blocking defect found and fixed by this run.** The production build prerendered most routes statically, so
their `<script>` tags carried no CSP nonce and `script-src 'nonce-…' 'strict-dynamic'` blocked every chunk:
the login page rendered its shell and never hydrated. The dev server renders dynamically, which is why every
earlier check passed. Fix: `export const dynamic = "force-dynamic"` in the root layout; guard: the smoke spec
asserts hydration with zero CSP console errors and CI now runs it against the standalone server
(`.github/workflows/ci.yml`, frontend job).

### AI red-team

- `tests/security_regression/test_ai_redteam.py` (new, 7 tests) + `test_ai_security.py` (6): indirect injection
  through email and WhatsApp bodies is delimited, escaped, flagged `untrusted="high"`, truncated and never
  followed; cross-tenant probes on every AI endpoint answer 404 with no model call; prompts never carry
  provider tokens or credentials; anonymous calls are refused; the per-organization daily token budget is
  shared and enforced before any model call; model output containing markup, control characters, action claims
  or the canary is neutralised; an unconfigured live provider answers `503 ai_unavailable` (it used to be an
  unhandled 500, found by the live harness and fixed in `apps/ai/features.py`).
- `security/ai-redteam/redteam_live.py` (new): the same probes against a running stack through the public API,
  for staging with the real Anthropic key. Local run against the fake provider: 39 probes, 0 findings.
- **Not done here: the run with a real `ANTHROPIC_API_KEY`.** No key is available on this machine or in the
  environment; the harness is ready (`--base https://staging… --email … --other-email … --quota`).

### Performance

Deal list on the 12,000-deal tenant: planner mis-estimate under RLS traced to the INNER joins on the
RLS-filtered `pipelines` tables; fixed by prefetching those relations (no RLS change). SQL 199 ms → 15 ms,
endpoint 232 ms → 36 ms; details and EXPLAIN evidence in `docs/operations/load-test-results.md`.

### Vitest determinism

The intermittent full-directory stall was reproduced as a cold run taking 43 s with 505 s of aggregated
jsdom environment time (one fork per core on a 24-core laptop) against 15-18 s for warm runs; no test-level
cause was found (eight consecutive clean runs, 147/147 before and 149/149 after this change). `vitest.config.ts` now bounds workers (2 in CI, ≤ 6
locally), sets test/hook/teardown timeouts so a stall fails with output, and CI jobs carry
`timeout-minutes: 25` so a hung run can never block a workflow for GitHub's 6-hour default.

### Gate results (final run)

| Gate | Result |
|---|---|
| Backend `pytest --cov` | 470 passed, 0 failed, coverage 83.75 % (threshold 80 %) |
| Frontend `vitest run` | 31 files / 149 tests passed, 3 consecutive runs (17-18 s each) |
| Playwright (production standalone build) | 28 / 28 |
| `manage.py rls_check` (migrated test database) | passed, all tenant-owned tables protected |
| `makemigrations --check` | no changes |
| RBAC: authz matrix + route coverage + cross-tenant generators (inside the backend run) | green |
| AI security + red-team (`test_ai_security.py`, `test_ai_redteam.py`, live harness) | 13 tests green; live harness 39 probes / 0 findings (fake provider) |
| `ruff check`, `ruff format --check`, `mypy` | clean (255 files) |
| Bandit | 0 findings |
| pip-audit `--strict` | no known vulnerabilities |
| Semgrep (project rules + `p/django`) | clean |
| pnpm audit `--audit-level=high` | no known vulnerabilities |
| Gitleaks (history and working tree, container) | no leaks |
| Trivy `keel-backend` (debian 13.7 + python packages) | 0 HIGH/CRITICAL fixable |
| Trivy `keel-frontend` (alpine 3.24.1 + node packages) | 0 HIGH/CRITICAL fixable |
| `next build` (standalone) + hydration smoke | builds, 38 dynamic routes, hydrates under CSP |

Fixes made during validation (all covered by tests): CSP nonce / static prerender (root layout `force-dynamic`),
deal-header WhatsApp action (permitted `primary_contact.phone` on deal payloads, no column added), deal list
planner regression (prefetch instead of INNER JOIN), unconfigured AI provider → 503, contacts table horizontal
overflow on phones (`relative` scroll wrapper), focus return after the quick-create dialog closes.

### Remaining Low / Info risks

- **Info** — the live-provider red-team has not run: no `ANTHROPIC_API_KEY` on this machine. Run
  `security/ai-redteam/redteam_live.py` against staging with the key before enabling AI for customers.
- **Low** — every role can read the member directory (`/settings/users`: names, emails, roles); writes are
  refused. Acceptable for a workspace tool; revisit if tenants need to hide colleagues from viewers.
- **Low** — WhatsApp inbound relies on the webhook secret and de-duplication; without `WHATSAPP_APP_SECRET`
  the endpoint refuses every POST (safe default) and replies never appear, which the UI now says.
- **Low** — `session expiry` in the browser suite is exercised through server-side revocation (allauth
  sessions); the 12-hour idle timeout itself is covered by backend tests only.
- **Info** — dashboard values are cached per member and invalidated by every CRM write; a lost Redis bump
  (restart) is bounded by the 60-second TTL.
- **Info** — the WhatsApp account endpoints share the `admin` throttle scope, so repeated E2E runs wait it out
  (the spec tolerates this); production traffic is unaffected.
