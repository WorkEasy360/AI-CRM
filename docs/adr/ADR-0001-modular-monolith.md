# ADR-0001 — Modular monolith on Django with a separate Next.js frontend

**Status:** Proposed

## Context
We need a production SaaS CRM with strong tenant isolation, a rich interactive UI, background processing and AI features, built incrementally by a small team. Microservices would multiply the authorization and tenancy surface and slow delivery; a server-rendered-only Django UI would not deliver the kanban/grid/calendar experience expected.

## Decision
One Django project split into cohesive apps with a service layer (`services.py`/`selectors.py`), Django REST Framework for the API, Celery for background work, PostgreSQL and Redis. A separate Next.js (React, TypeScript) frontend served from the same origin via the reverse proxy. Business logic lives only in services; views are thin.

## Consequences
- One deployable API, one database, one authorization implementation.
- App boundaries are the future extraction seams if scale demands.
- Same-origin deployment keeps cookie-based auth simple and secure.
- Requires discipline (Semgrep rules, review) to keep logic out of views and to avoid cross-app imports except through services.
