# Architecture Decision Records

Format: Context → Decision → Consequences. Status: Proposed until Phase 0 approval, then Accepted.

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](ADR-0001-modular-monolith.md) | Modular monolith on Django with a separate Next.js frontend | Proposed |
| [ADR-0002](ADR-0002-tenancy-shared-schema-rls.md) | Shared schema tenancy with `organization_id` and PostgreSQL RLS | Proposed |
| [ADR-0003](ADR-0003-session-auth-allauth.md) | Cookie sessions, same-origin API, django-allauth headless for auth and MFA | Proposed |
| [ADR-0004](ADR-0004-central-authz.md) | Central authorization service with permission catalogue and scopes | Proposed |
| [ADR-0005](ADR-0005-uuid-ids.md) | UUID primary keys for tenant resources | Proposed |
| [ADR-0006](ADR-0006-custom-fields-jsonb.md) | Custom fields stored as validated JSONB with a definitions table | Proposed |
| [ADR-0007](ADR-0007-optimistic-concurrency.md) | Optimistic concurrency via `version` and `If-Match` | Proposed |
| [ADR-0008](ADR-0008-infrastructure-aws-ecs.md) | AWS with ECS Fargate and managed data services (pending cloud decision) | Proposed |
| [ADR-0009](ADR-0009-ai-tool-layer.md) | AI as an untrusted subsystem behind a typed, permission-gated tool layer with human-confirmed actions | Proposed |
| [ADR-0010](ADR-0010-dependency-policy.md) | Dependency introduction and supply-chain policy | Proposed |
| [ADR-0011](ADR-0011-search-postgres.md) | PostgreSQL full-text search before any search engine | Proposed |
| [ADR-0012](ADR-0012-money-and-currency.md) | Money handling and multi-currency snapshotting | Proposed |
