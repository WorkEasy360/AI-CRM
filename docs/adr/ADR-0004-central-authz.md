# ADR-0004 — Central authorization service with permission catalogue and scopes

**Status:** Accepted (2026-09-12); implemented in Phase 1

## Context
Authorization must be deny-by-default, consistent across API, background jobs and AI tools, and evolvable toward custom roles, record sharing and field-level permissions.

## Decision
A code-defined permission catalogue (`module.action`), roles as sets of `(permission, scope)` with scope in `{own, team, all}`, and a single `authz` service exposing `check(actor, permission, obj)` and `scope(actor, permission, queryset)`. DRF views declare a `permission_map`; selectors apply `scope()`; services re-check on the loaded object. A test enumerates all routes and fails if any lacks a mapping.

## Consequences
- One place to reason about and test authorization; the matrix test is generated from role definitions.
- Slight duplication of checks (view gate + service object check) is intentional defense in depth.
- Custom roles, record sharing and field policies extend the same primitives without changing call sites.
