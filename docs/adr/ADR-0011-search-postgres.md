# ADR-0011 — PostgreSQL full-text search before any search engine

**Status:** Proposed

## Context
Global search across contacts, companies, deals, products and activities must be tenant- and permission-scoped. A separate search engine adds infrastructure and a second copy of data that must also enforce isolation.

## Decision
Each searchable table has a trigger-maintained `search_vector tsvector` (weighted: name/title A, email/phone/SKU B, description/notes C) with a GIN index, plus trigram indexes on name columns for prefix/typo matching. Queries use `websearch_to_tsquery` and run through scoped managers and `authz.scope()`. Results are merged and ranked in the service with per-entity limits. A dedicated search engine is considered only when measured latency on real tenants exceeds targets.

## Consequences
- No extra infrastructure and no second isolation model.
- Relevance is adequate for CRM-sized datasets; advanced features (facets at scale, fuzzy semantic search) are deferred.
