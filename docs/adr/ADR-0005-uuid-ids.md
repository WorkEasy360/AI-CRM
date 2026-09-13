# ADR-0005 — UUID primary keys for tenant resources

**Status:** Proposed

## Context
Sequential integer ids leak record counts and invite enumeration; externally exposed ids should be unguessable. Alternatives: bigint PK with a separate public UUID column (two ids to manage) or UUID PKs everywhere.

## Decision
UUID (v4) primary keys on all tenant-owned and externally referenced tables. Authorization never relies on unguessability: every lookup still passes tenant scoping, `authz.scope()` and RLS.

## Consequences
- Simpler code (one id), no enumeration of counts or ordering.
- Larger indexes and random insert order on B-trees; acceptable at the expected scale. If insert performance becomes an issue, time-ordered UUIDs (v7) can be adopted by changing the default generator without schema changes.
