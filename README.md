# Keel CRM (working codename)

An original, security-first, multi-tenant SaaS CRM with sales pipelines, contacts, companies, products, activities, dashboards and an AI sales copilot. Built with Django 5.2 LTS, Django REST Framework, PostgreSQL, Redis, Celery, and Next.js/TypeScript.

Status: **Phases 3-5 implemented (2026-09-13) on top of the approved Phase 1/2 foundation** — tasks, calls and meetings with a calendar; contact/company lifecycle (lead → prospect → qualified → customer); unified timeline; notifications; email via Gmail/Microsoft 365 OAuth; WhatsApp Business Cloud API; deterministic forecast; rules-based lead score, deal risk and next best action; AI deal summaries and drafts (Anthropic Claude, permission-gated, budgeted, drafts only); **Ask Keel**, one Dashboard assistant that answers from authorized SQL plus a pgvector knowledge index over notes, emails, WhatsApp and meeting write-ups, and keeps answering from CRM data when no model is available. Security gate for this batch: `docs/security/gates/phase-3-5.md`.

## Quick start
See [`docs/environment-setup.md`](docs/environment-setup.md). Short version:

```bash
cp .env.example .env
docker compose up -d --wait postgres redis mailpit   # Windows: pwsh -File scripts/dev.ps1 does this and more
cd backend && uv sync && uv run python manage.py migrate && uv run python manage.py runserver 8000
cd backend && uv run celery -A config.celery worker -l info -Q default,notifications   # emails, metrics
cd backend && uv run celery -A config.celery worker -l info -Q imports,exports,reports  # CSV jobs
cd ../frontend && pnpm install && pnpm dev
```

## Documentation

Start at [`docs/00-phase0-overview.md`](docs/00-phase0-overview.md). Key documents:

- Architecture: [`docs/architecture/`](docs/architecture/) — database, multi-tenancy, authentication, RBAC, API, AI, infrastructure, [scaling and load balancing](docs/architecture/scaling.md)
- Operations: [`docs/operations/`](docs/operations/) — load testing, results, alerts and failure drills; infrastructure as code in [`infra/terraform/`](infra/terraform/)
- Security: [`docs/security/threat-model.md`](docs/security/threat-model.md), [`docs/security/security-architecture.md`](docs/security/security-architecture.md), gates: [`phase-1`](docs/security/gates/phase-1.md), [`phase-2`](docs/security/gates/phase-2.md)
- Plan: [`docs/plan/development-phases.md`](docs/plan/development-phases.md), [`docs/plan/phase-1-plan.md`](docs/plan/phase-1-plan.md), [`docs/plan/phase-2-plan.md`](docs/plan/phase-2-plan.md)
- API: [`docs/api/README.md`](docs/api/README.md)
- Decisions: [`docs/adr/`](docs/adr/), [`docs/DECISIONS-REQUIRED.md`](docs/DECISIONS-REQUIRED.md)

## Non-negotiables

- Tenant isolation enforced in the ORM (fail-closed managers) and by PostgreSQL Row Level Security, tested on every endpoint.
- Authorization is deny-by-default and enforced on the server in one place.
- The AI never receives database access; it uses permission-gated tools and every state change needs human confirmation.
- Security review and a written security gate at the end of every phase.
