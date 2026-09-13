# Phase 0 — Architecture Overview

Working codename: **Keel CRM** (placeholder until a product name is chosen; see `docs/DECISIONS-REQUIRED.md`).
Status: **DRAFT — awaiting approval before Phase 1 coding begins.**

This document is the entry point for the Phase 0 architecture package:

| Doc | Content |
|---|---|
| `docs/00-phase0-overview.md` (this file) | Reference analysis, functional modules, system architecture, repository structure |
| `docs/architecture/database-design.md` | ERD, entity catalogue, cardinality, indexes, constraints, deletion behaviour |
| `docs/architecture/multi-tenancy.md` | Tenant strategy, tenant context resolution, ORM scoping, PostgreSQL RLS |
| `docs/architecture/authentication.md` | Session model, MFA, passkeys, password reset, session rotation |
| `docs/architecture/rbac.md` | Roles, permission catalogue, scope levels, enforcement points |
| `docs/architecture/api-architecture.md` | API conventions, versioning, pagination, errors, concurrency control |
| `docs/architecture/ai-architecture.md` | Copilot, tool layer, scoring, forecasting, next-best-action, AI security |
| `docs/architecture/infrastructure.md` | Runtime topology, environments, secrets, backups, CI/CD |
| `docs/security/threat-model.md` | Assets, actors, trust boundaries, STRIDE analysis, ranked threats |
| `docs/security/security-architecture.md` | Control catalogue mapped to threats and phases |
| `docs/plan/development-phases.md` | Phase 1–6 scope and security gates |
| `docs/plan/phase-1-plan.md` | Concrete Phase 1 implementation plan |
| `docs/adr/` | Architecture Decision Records |
| `docs/DECISIONS-REQUIRED.md` | Decisions that need the product owner's approval before coding |

---

## A. Analysis of the reference screenshots

The six reference screens describe a small-business sales CRM. Only the workflows and information architecture are taken from them; the visual identity, naming, icons and layout will be original.

### Screen 1 — Pipeline (Kanban)
- Left rail: "Team Pipelines" list with an active pipeline; templates by team/industry.
- Top bar: filter, saved view selector ("All Deals"), sort control, view switcher (kanban / list / sheet), primary "+ Deal" action.
- Columns are stages: Qualification, Needs Analysis, Proposal/Price Quote, Negotiation/Review, Closed Won, Closed Lost. Each column header shows **stage total amount** and **deal count**; each column allows a stage description.
- Deal card: name, primary contact, amount (₹ formatted), expected close date, an activity / "has open task" indicator.
- Bottom: pipeline tabs (multiple pipelines) with "+" to add another.
- Empty stages show an inline "+ Deal" and a collapse control.

Takeaways: multiple pipelines per org, per-stage aggregates, card-level quick facts, drag-and-drop, saved views, three list modes for the same collection.

### Screen 2 — Contacts (sheet / grid view)
- Saved view selector ("All Contacts"), view switcher (list / sheet), "+ Contact".
- Spreadsheet-style grid: Contact Name, Company Name, Email, Phone, Contact Owner, plus an inline "+ Create Field" affordance (custom fields created directly from the grid header).
- Footer KPIs: Total Contacts, Contacts With Open Pipelines, Without Pipelines, Untouched; records-per-page and pagination.
- Selected cell shows a highlighted editing state (inline editing).

Takeaways: data grid with inline edit, column-level custom fields, footer summary counts derived from relationships (contact ↔ open deals; "untouched" = no activity).

### Screen 3 — Companies
- Same grid pattern: Company Name, Phone, Website, Company Owner, "+ Create Field".
- Footer KPIs: Total, With Open Pipelines, Without Pipelines, With Won Pipelines.
- URL shows a per-record sheet route (`/companies/sheet/<id>`).

Takeaways: uniform collection UX across entities; consistent KPIs; per-entity custom fields.

### Screen 4 — Products (empty state)
- Onboarding empty state: "Add Product" or "Import From a File".
- Copy explains that products link to deals and pipelines.

Takeaways: every collection needs an empty state with create + import; CSV import is a first-class path.

### Screen 5 — Activities (Calendar)
- Tabs: Calendar, Tasks, Events, Calls.
- Month/Week/Day toggle, Today, prev/next, a mini-calendar, a "Booking Pages" entry point.
- Right panel: "My Preferences", Activity Types toggles (Tasks, Events, Calls), Ownership filter, Sync Options (Google / Microsoft icons).
- A task ("Prepare a presentation…") rendered on 17 Sep.

Takeaways: unified activity calendar across three activity types; per-type visibility toggles; ownership filter; external calendar sync is expected later (kept behind an integration boundary).

### Screen 6 — Dashboard
- Dashboard selector ("Overview"), refresh, "+ Component".
- KPI cards with month-over-month comparison ("1 ▲ 100%, Last Month: 0"): Contacts Created, Deals Won, Deals Lost, Tasks Closed, Events Completed, Calls Completed.
- Ranked list: Top 5 Companies. Bar chart: Open Deals by Stage.
- "No data available" empty states per widget.

Takeaways: dashboards are compositions of widgets with a shared date window; each widget has a comparison period and an empty state; widgets are individually refreshable.

### Cross-cutting observations
- Global search (Ctrl+K) scoped by module ("All" selector).
- Header: notifications, settings, quick-add "+", user avatar, trial/upgrade banner (billing exists in the reference but is out of MVP scope for us).
- Everything is owner-attributed ("Contact Owner", "Company Owner"): ownership drives visibility and dashboards.
- Currency-aware amounts; the reference account is on an Indian data centre (`.in`), so data residency is a real question for us (see Decisions).

---

## B. Functional modules identified

| # | Module | Core capabilities | Phase |
|---|---|---|---|
| 1 | Organizations & Tenancy | Org creation, settings, base currency, timezone, data retention | 1 |
| 2 | Identity & Access | Signup, email verification, login, MFA (TOTP, recovery codes), passkeys (architecture), password reset, sessions, invitations | 1 |
| 3 | Teams, Roles & Permissions | 5 system roles, permission catalogue, ownership scopes, teams | 1 |
| 4 | Audit Log | Append-only security/business event log, admin viewer | 1 |
| 5 | Companies | CRUD, grid/list/detail, timeline, KPIs, custom fields | 2 |
| 6 | Contacts | CRUD, grid/list/detail, dedupe, KPIs, custom fields, notes | 2 |
| 7 | Products | CRUD, pricing, tax, status, deal line items | 2 |
| 8 | Pipelines & Stages | Multiple pipelines, ordered stages, won/lost stage types, probability defaults, per-stage aggregates | 2 |
| 9 | Deals | CRUD, kanban drag-and-drop, stage history, products, tags, optimistic concurrency, won/lost | 2 |
| 10 | Custom Fields | Definitions per entity, 13 types, validation, grid integration | 2 |
| 11 | Tags & Notes | Tagging across entities; notes on any record | 2 |
| 12 | Saved Views & Filters | Per-user/shared views with filter/sort/column config | 2 |
| 13 | Global Search | Tenant + permission scoped PostgreSQL full-text search | 2 |
| 14 | Import / Export | CSV import (async, validated, mapped) and export (async, formula-injection safe, audited) | 2 (contacts/companies/products), 3 (deals, activities) |
| 15 | Activities: Tasks, Events, Calls | CRUD, links to contact/company/deal, owner, status, priority, reminders | 3 |
| 16 | Calendar | Month/week/day, type toggles, ownership filter | 3 |
| 17 | Notifications | In-app + email notifications, reminder delivery via Celery Beat | 3 |
| 18 | Dashboards & Widgets | Configurable dashboards, widget catalogue, date/owner/team filters, cached aggregates | 3 |
| 19 | Reports | Tabular reports (deals by stage/owner, activity reports, conversion, cycle length), export | 3 |
| 20 | AI Copilot | Chat panel with tenant-aware tools, summaries, NL questions, drafts | 4 |
| 21 | AI Scoring | Rules-based opportunity score with explanations; predictive path gated on data | 4 |
| 22 | Forecasting | Weighted pipeline, expected revenue by period; ML later | 4 |
| 23 | Next-Best-Action | Evidence-backed recommendations with confidence | 4 |
| 24 | Integrations | Webhooks (outbound/inbound), Google/Microsoft calendar + mail adapters, credential vault | 5 |
| 25 | Privacy & Data Lifecycle | Data export, user deletion, tenant deletion, retention jobs | 1 (design), 6 (complete) |

---

## C. Recommended architecture

### C.1 Style
A **modular monolith**: one Django codebase with strictly separated apps and a service layer, one PostgreSQL database, Redis for cache/queues, Celery workers for background work, and a separate Next.js frontend. This is the simplest architecture that supports a real multi-tenant SaaS and can be split later along the app boundaries if scale demands it.

### C.2 Runtime topology

```
                         ┌──────────────────────────────┐
   Browser ── HTTPS ───▶ │  Reverse proxy (Nginx / ALB)  │
                         │  TLS, WAF, rate limits        │
                         └──────┬───────────────┬────────┘
                    /  (pages)  │               │  /api/, /auth/  (same origin)
                                ▼               ▼
                     ┌──────────────┐    ┌───────────────────┐
                     │ Next.js (SSR)│    │ Django + DRF (API) │
                     │ no secrets   │    │ gunicorn           │
                     └──────────────┘    └───┬──────┬─────────┘
                                             │      │
                              ┌──────────────┘      └────────┐
                              ▼                              ▼
                     ┌─────────────────┐            ┌──────────────────┐
                     │ PostgreSQL 16   │            │ Redis            │
                     │ RLS enabled     │            │ cache, broker,   │
                     │ pgbouncer (txn) │            │ rate limits      │
                     └─────────────────┘            └────────┬─────────┘
                                                             ▼
                                             ┌──────────────────────────┐
                                             │ Celery workers + Beat    │
                                             │ imports/exports, email,  │
                                             │ reminders, analytics,    │
                                             │ AI scoring, webhooks     │
                                             └───────┬──────────┬───────┘
                                                     ▼          ▼
                                       ┌──────────────┐  ┌───────────────────┐
                                       │ S3-compatible│  │ LLM provider      │
                                       │ object store │  │ (behind adapter)  │
                                       └──────────────┘  └───────────────────┘
        Secrets: cloud secrets manager + KMS.   Logs/metrics: structured JSON → log sink → SIEM-ready.
```

Frontend and API are served from the **same origin** through the reverse proxy (`/api/*` and `/auth/*` → Django, everything else → Next.js). This lets us use `HttpOnly`, `Secure`, `SameSite=Lax` session cookies with Django's CSRF protection and no cross-origin cookie complexity. No JWTs in the browser.

### C.3 Backend layering (per Django app)

```
apps/<domain>/
  models.py        # TenantModel subclasses, constraints, indexes
  services.py      # ALL business logic; transactional; takes an Actor + validated data
  selectors.py     # Read/query functions; always return authz-scoped querysets
  serializers.py   # DRF input/output schemas; explicit fields; never fields = "__all__"
  views.py         # Thin DRF viewsets: auth → authz → serializer → service → response
  permissions.py   # Permission map for this app's routes
  tasks.py         # Celery tasks (receive org_id + actor_id explicitly)
  tests/           # unit, api, authz, tenant-isolation, security
```

Rules: views never contain business logic; services never trust the request; every selector applies `authz.scope()`; every write goes through a service in a transaction and emits an audit event where required.

### C.4 Frontend architecture (Next.js App Router, TypeScript strict)

```
frontend/src/
  app/                 # routes: (auth)/login, (app)/dashboard, pipeline, contacts, companies, products, activities, reports, settings
  components/ui/       # design-system primitives (Button, Input, Dialog, DataGrid, Kanban, Calendar)
  components/crm/      # domain components (DealCard, ContactGrid, ActivityForm, CopilotDrawer)
  features/<domain>/   # hooks, API clients, zod schemas, state per domain
  lib/api/             # typed fetch client (credentials: include, CSRF header), generated OpenAPI types
  lib/auth/            # session provider; server-side session check for protected layouts
  styles/              # tokens (colour, type, spacing), Tailwind config
```

State: TanStack Query for server state; minimal client state. Forms: react-hook-form + zod (schemas mirror server validation but never replace it). No `dangerouslySetInnerHTML`; rich text is deferred, and notes are plain text/markdown rendered through a safe renderer.

### C.5 Key cross-cutting mechanisms
- **Tenant context**: resolved server-side from the session's membership (`docs/architecture/multi-tenancy.md`).
- **Authorization**: one `authz` service with `check()` and `scope()`; deny by default; every route declares required permissions (`docs/architecture/rbac.md`).
- **Audit**: `audit.record()` called from services; the application DB role cannot update or delete audit rows.
- **Concurrency**: integer `version` on mutable records; clients send `If-Match`; 409 on mismatch.
- **Background work**: Celery tasks receive `organization_id` + `actor_user_id` and re-establish tenant context + RLS before touching data.
- **Search**: PostgreSQL `tsvector` columns maintained by triggers; queries go through `authz.scope()`.
- **AI**: tool-calling copilot restricted to typed, tenant-scoped, permission-checked tools; proposals require human confirmation (`docs/architecture/ai-architecture.md`).

---

## D. Repository structure (monorepo)

```
keel-crm/
├── README.md
├── docs/                          # this architecture package + living docs
├── .github/workflows/             # ci.yml (tests, lint, types, SAST, deps, secrets), deploy.yml
├── .gitleaks.toml
├── docker-compose.yml             # dev: postgres, redis, backend, worker, beat, frontend, mailpit
├── Makefile                       # make dev / test / lint / security
├── backend/
│   ├── pyproject.toml             # pinned deps; uv.lock committed
│   ├── uv.lock
│   ├── Dockerfile                 # multi-stage, non-root, minimal
│   ├── manage.py
│   ├── config/
│   │   ├── settings/{base,dev,test,prod}.py
│   │   ├── urls.py
│   │   ├── celery.py
│   │   └── wsgi.py
│   ├── apps/
│   │   ├── core/                  # TenantModel, managers, tenant context, base exceptions, utils
│   │   ├── accounts/              # User, Organization, Membership, Invitation, auth endpoints
│   │   ├── authz/                 # Role, permission catalogue, check(), scope(), DRF permission classes
│   │   ├── audit/                 # AuditEvent, record(), admin viewer API
│   │   ├── teams/                 # Team, TeamMembership
│   │   ├── companies/
│   │   ├── contacts/
│   │   ├── products/
│   │   ├── pipelines/             # Pipeline, PipelineStage
│   │   ├── deals/                 # Deal, DealStageHistory, DealProduct
│   │   ├── customfields/          # CustomFieldDefinition, validation, JSONB helpers
│   │   ├── tagging/               # Tag, TaggedItem
│   │   ├── notes/
│   │   ├── savedviews/            # SavedView
│   │   ├── search/
│   │   ├── activities/            # Task, Event, Call, Reminder
│   │   ├── notifications/
│   │   ├── dashboards/            # Dashboard, Widget, metric services, cache
│   │   ├── reports/
│   │   ├── importexport/          # ImportJob, ExportJob, CSV pipeline, attachments
│   │   ├── ai/                    # providers/, tools/, copilot/, scoring/, forecasting/, nba/
│   │   ├── integrations/          # Integration, credential vault, webhooks, calendar/mail adapters
│   │   └── privacy/               # data export, deletion, retention jobs
│   ├── security/                  # middleware (headers, request id), CSP config, throttles, SSRF guard
│   └── tests/                     # cross-cutting: tenant_isolation/, authz_matrix/, security_regression/
├── frontend/
│   ├── package.json / pnpm-lock.yaml
│   ├── Dockerfile
│   ├── next.config.ts
│   ├── src/                       # see C.4
│   └── tests/                     # vitest unit, playwright e2e
├── infra/
│   ├── nginx/                     # reverse proxy config, security headers, rate limits
│   ├── terraform/                 # cloud resources (Phase 6; skeleton earlier)
│   └── scripts/                   # backup, restore-test, rls-check
└── security/
    ├── semgrep/                   # custom rules (e.g. "no unscoped queryset in views")
    └── zap/                       # DAST config for staging
```

---

## E–L. Pointers
Sections E (database), F (multi-tenancy), G (RBAC), H (AI), I (threat model) and J (security architecture) each have a dedicated document listed at the top of this file. Section K (phases) and L (Phase 1 plan) are under `docs/plan/`.
