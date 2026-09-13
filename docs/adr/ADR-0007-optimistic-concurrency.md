# ADR-0007 — Optimistic concurrency via `version` and `If-Match`

**Status:** Accepted (2026-09-12); implemented in Phase 2 (`apps/core/concurrency.py`)

## Context
Multiple users edit the same deal/contact concurrently (kanban drags, inline grid edits, AI-proposed actions confirmed later). Silent last-writer-wins would lose data.

## Decision
Mutable resources carry an integer `version`. Update and stage-move requests must include `If-Match: "<version>"` (or `version` in the body); the service performs `UPDATE ... WHERE id = ? AND version = ?` inside a transaction (with `select_for_update` on stage moves) and returns `409 Conflict` with the current representation on mismatch. AI proposals capture the version at proposal time and re-check at confirmation.

## Consequences
- Conflicts are surfaced to the user (UI offers reload/merge) instead of silently overwriting.
- Clients must carry `version`; the generated API client does this automatically.
- Bulk operations apply per-record checks and report conflicts per id.
