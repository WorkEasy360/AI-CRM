# Architecture Decision Records

Format: Context → Decision → Consequences. All ADRs were accepted with the Phase 0 approval on 2026-09-12; the status line in each ADR records the phase in which it was implemented.

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](ADR-0001-modular-monolith.md) | Modular monolith on Django with a separate Next.js frontend | Accepted |
| [ADR-0002](ADR-0002-tenancy-shared-schema-rls.md) | Shared schema tenancy with `organization_id` and PostgreSQL RLS | Accepted |
| [ADR-0003](ADR-0003-session-auth-allauth.md) | Cookie sessions, same-origin API, django-allauth headless for auth and MFA | Accepted |
| [ADR-0004](ADR-0004-central-authz.md) | Central authorization service with permission catalogue and scopes | Accepted |
| [ADR-0005](ADR-0005-uuid-ids.md) | UUID primary keys for tenant resources | Accepted |
| [ADR-0006](ADR-0006-custom-fields-jsonb.md) | Custom fields stored as validated JSONB with a definitions table | Accepted |
| [ADR-0007](ADR-0007-optimistic-concurrency.md) | Optimistic concurrency via `version` and `If-Match` | Accepted |
| [ADR-0008](ADR-0008-infrastructure-aws-ecs.md) | AWS with ECS Fargate and managed data services (ap-south-1) | Accepted |
| [ADR-0009](ADR-0009-ai-tool-layer.md) | AI as an untrusted subsystem behind a typed, permission-gated tool layer with human-confirmed actions | Accepted |
| [ADR-0010](ADR-0010-dependency-policy.md) | Dependency introduction and supply-chain policy | Accepted |
| [ADR-0011](ADR-0011-search-postgres.md) | PostgreSQL full-text search before any search engine | Accepted |
| [ADR-0012](ADR-0012-money-and-currency.md) | Money handling and multi-currency snapshotting | Accepted |
