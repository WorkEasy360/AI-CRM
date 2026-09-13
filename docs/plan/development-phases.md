# Development Phases

Each phase ends with a **Security Gate** (template in `docs/security/security-architecture.md` §5). No phase starts while a Critical or High finding from the previous gate is open.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Architecture** (approved 2026-09-12) | Architecture, ERD, tenancy, auth, authz, threat model, AI architecture, infra, ADRs | Product owner approves decisions in `docs/DECISIONS-REQUIRED.md` |
| **1 — Secure foundation** (gate approved 2026-09-13) | Repo scaffold, Docker dev env, CI; `core` (TenantModel, context, RLS), `accounts` (org, user, membership, invitations, auth flows, MFA), `authz` (roles, permissions, check/scope), `teams`, `audit`, security middleware, throttles, problem-details errors, OpenAPI, structured logging; frontend shell (auth pages, app layout, navigation, session handling, design tokens); test infrastructure incl. cross-tenant and authz matrix generators | All Phase 1 tests green; gate passed; `docs/plan/phase-1-plan.md` checklist complete |
| **2 — CRM core** (implemented 2026-09-13, gate pending approval) | Companies, Contacts, Products, Pipelines/Stages, Deals (kanban, stage moves, history, products, won/lost), Custom fields, Tags, Notes + record timeline, Search, CSV import/export (import: contacts, companies, products; export: + deals); frontend grids, kanban, detail pages, custom-field UI. Deferred to Phase 3: saved views, attachments (see `docs/plan/phase-2-plan.md`) | Critical workflow e2e (org → company → contact → deal → product → stage moves) passes; gate passed |
| **3 — Sales operations** (implemented 2026-09-13; gate `docs/security/gates/phase-3-5.md`) | Tasks/Calls/Meetings, calendar (month/week/day), reminders (Beat), notifications (in-app + email), dashboards + widget catalogue + metric snapshots, reports + exports (deals, activities) | Dashboard updates correctly after workflow; gate passed |
| **4 — AI** (implemented 2026-09-13: rules-based scoring/risk/next best action, deterministic forecast, summaries and drafts behind the Anthropic adapter with budgets; copilot chat, NL analytics and proposed actions deferred) | Provider adapter, tool catalogue, copilot (streaming, tools, proposals), summaries, NL analytics, email drafts, rules-based scoring, forecasting (weighted), next-best-action, budgets/ledger, AI settings, red-team suite; predictive scoring only where the data gate is met | AI security review; red-team suite green; gate passed |
| **5 — Integrations** (email OAuth + WhatsApp Cloud API implemented 2026-09-13; webhooks framework, calendar sync and personal access tokens deferred) | Integration framework, credential vault (KMS envelope), outbound webhooks (HMAC, retries), inbound webhook verification, Google + Microsoft calendar sync adapters (OAuth + PKCE), email-sending provider for drafts, personal access tokens | Gate passed; SSRF/replay/credential tests green |
| **6 — Production hardening** | Terraform for prod, WAF, secrets rotation, monitoring/alerting, SIEM export, DAST (ZAP) on staging, container/dependency/secret scans as release blockers, tenant-isolation penetration test, RBAC fuzzing, AI red-team round 2, backup restore drill, load test, privacy workflows (export/delete/tenant deletion/retention), runbooks (incident response, backup/restore, on-call) | Restore test succeeded; load test targets met; all gates green; go-live checklist signed |

## Critical business workflow (tested end-to-end from Phase 2 onward, extended each phase)

Create Organization → Invite User → Create Company → Create Contact → Create Deal → Add Product → Move Deal through stages → Schedule Activity → Ask AI for deal summary → Mark Deal Won → Dashboard updates correctly.

## Working agreements

- One vertical slice at a time: model → service → serializer → view → tests → frontend → docs.
- Every PR runs the full CI security set; a PR that adds an endpoint without `permission_map` and cross-tenant tests fails.
- Dependencies are added only with an ADR-0010 review note in the PR description.
- Documentation in `docs/` is updated in the same PR as the code it describes.
