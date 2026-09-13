# Keel CRM (working codename)

An original, security-first, multi-tenant SaaS CRM with sales pipelines, contacts, companies, products, activities, dashboards and an AI sales copilot. Built with Django 5.2 LTS, Django REST Framework, PostgreSQL, Redis, Celery, and Next.js/TypeScript.

Status: **Phase 1 (secure foundation) implemented — awaiting the Phase 1 security-gate approval before Phase 2 (CRM core).**

## Quick start
See [`docs/environment-setup.md`](docs/environment-setup.md). Short version:

```bash
cp .env.example .env
docker compose up -d postgres redis mailpit
cd backend && uv sync && uv run python manage.py migrate && uv run python manage.py runserver 8000
cd ../frontend && pnpm install && pnpm dev
```

## Documentation

Start at [`docs/00-phase0-overview.md`](docs/00-phase0-overview.md). Key documents:

- Architecture: [`docs/architecture/`](docs/architecture/) — database, multi-tenancy, authentication, RBAC, API, AI, infrastructure
- Security: [`docs/security/threat-model.md`](docs/security/threat-model.md), [`docs/security/security-architecture.md`](docs/security/security-architecture.md), [`docs/security/gates/phase-1.md`](docs/security/gates/phase-1.md)
- Plan: [`docs/plan/development-phases.md`](docs/plan/development-phases.md), [`docs/plan/phase-1-plan.md`](docs/plan/phase-1-plan.md)
- API: [`docs/api/README.md`](docs/api/README.md)
- Decisions: [`docs/adr/`](docs/adr/), [`docs/DECISIONS-REQUIRED.md`](docs/DECISIONS-REQUIRED.md)

## Non-negotiables

- Tenant isolation enforced in the ORM (fail-closed managers) and by PostgreSQL Row Level Security, tested on every endpoint.
- Authorization is deny-by-default and enforced on the server in one place.
- The AI never receives database access; it uses permission-gated tools and every state change needs human confirmation.
- Security review and a written security gate at the end of every phase.
