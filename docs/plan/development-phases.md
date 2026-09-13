# Development Phases

Each phase ends with a **Security Gate** (template in `docs/security/security-architecture.md` §5). No phase starts while a Critical or High finding from the previous gate is open.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Architecture** (this package) | Architecture, ERD, tenancy, auth, authz, threat model, AI architecture, infra, ADRs | Product owner approves decisions in `docs/DECISIONS-REQUIRED.md` |
| **1 — Secure foundation** | Repo scaffold, Docker dev env, CI; `core` (TenantModel, context, RLS), `accounts` (org, user, membership, invitations, auth flows, MFA), `authz` (roles, permissions, check/scope), `teams`, `audit`, security middleware, throttles, problem-details errors, OpenAPI, structured logging; frontend shell (auth pages, app layout, navigation, session handling, design tokens); test infrastructure incl. cross-tenant and authz matrix generators | All Phase 1 tests green; gate passed; `docs/plan/phase-1-plan.md` checklist complete |
| **2 — CRM core** | Companies, Contacts, Products, Pipelines/Stages, Deals (kanban, stage moves, history, products, won/lost), Custom fields, Tags, Notes, Saved views, Search, CSV import/export (contacts, companies, products), attachments; frontend grids, kanban, detail pages, custom-field UI | Critical workflow e2e (org → company → contact → deal → product → stage moves) passes; gate passed |
| **3 — Sales operations** | Tasks/Events/Calls, calendar (month/week/day), reminders (Beat), notifications (in-app + email), dashboards + widget catalogue + metric snapshots, reports + exports (deals, activities) | Dashboard updates correctly after workflow; gate passed |
| **4 — AI** | Provider adapter, tool catalogue, copilot (streaming, tools, proposals), summaries, NL analytics, email drafts, rules-based scoring, forecasting (weighted), next-best-action, budgets/ledger, AI settings, red-team suite; predictive scoring only where the data gate is met | AI security review; red-team suite green; gate passed |
| **5 — Integrations** | Integration framework, credential vault (KMS envelope), outbound webhooks (HMAC, retries), inbound webhook verification, Google + Microsoft calendar sync adapters (OAuth + PKCE), email-sending provider for drafts, personal access tokens | Gate passed; SSRF/replay/credential tests green |
| **6 — Production hardening** | Terraform for prod, WAF, secrets rotation, monitoring/alerting, SIEM export, DAST (ZAP) on staging, container/dependency/secret scans as release blockers, tenant-isolation penetration test, RBAC fuzzing, AI red-team round 2, backup restore drill, load test, privacy workflows (export/delete/tenant deletion/retention), runbooks (incident response, backup/restore, on-call) | Restore test succeeded; load test targets met; all gates green; go-live checklist signed |

## Critical business workflow (tested end-to-end from Phase 2 onward, extended each phase)

Create Organization → Invite User → Create Company → Create Contact → Create Deal → Add Product → Move Deal through stages → Schedule Activity → Ask AI for deal summary → Mark Deal Won → Dashboard updates correctly.

## Working agreements

- One vertical slice at a time: model → service → serializer → view → tests → frontend → docs.
- Every PR runs the full CI security set; a PR that adds an endpoint without `permission_map` and cross-tenant tests fails.
- Dependencies are added only with an ADR-0010 review note in the PR description.
- Documentation in `docs/` is updated in the same PR as the code it describes.
