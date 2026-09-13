# Phase 2 — CRM Core: Implementation Record

**Status (2026-09-13): implemented; Security Gate report at `docs/security/gates/phase-2.md`, awaiting product-owner approval before Phase 3.**

Scope delivered, in the order requested: Companies → Contacts → Products → Pipelines + Stages → Deals → Deal stage history → Custom fields → Tags → Notes / record timeline → tenant-scoped global search → CSV import/export. Frontend: data tables for Contacts/Companies/Products, Kanban + list for Pipelines/Deals, detail pages, settings for pipelines/custom fields/tags/data, global search (Ctrl+K) and quick-add in the shell.

## 1. Architecture additions

| Piece | Where | Purpose |
|---|---|---|
| `OwnedModel`, `VersionedModel`, `ArchivableModel`, `CrmRecord` | `apps/core/models.py` | Ownership (drives own/team scopes), optimistic concurrency, soft delete, `custom_data`, `created_by/updated_by` |
| `apps/core/concurrency.py` | core | `If-Match` / `version` parsing (428 when missing), guarded `UPDATE … WHERE version = ?` (409 on mismatch) |
| `apps/core/records.py` | core | One implementation of create / update / archive / restore / bulk for every CRM record: authorization, ownership rules (`resolve_owner`), audit |
| `apps/core/api/filters.py` | core | Allowlisted filters, sorts (stable `id` tiebreak), text search, `custom.<key>` filters; unknown keys → 400 |
| `apps/core/api/crm.py` | core | `CrmViewSet`: list/retrieve/create/update/archive/restore/tags/count/bulk with batch-loaded tags and custom-field definitions |
| `apps/core/validators.py` | core | Text control-character stripping, http(s)-only URLs (rejects `javascript:` etc.), phone/currency/amount/address validators |
| `apps/core/search.py` | core | Migration helper for trigger-maintained `search_vector` columns |
| `apps/customfields` | new app | Definitions + the only validation path for `custom_data` (ADR-0006) |
| `apps/tagging` | new app | Tags and tagged items (generic `entity_type/entity_id`, validated through the scoped record) |
| `apps/companies`, `apps/contacts`, `apps/products` | new apps | Records on top of `CrmRecord` + `CrmViewSet` |
| `apps/pipelines` | new app | Pipelines and stages; default pipeline created with every organization; deferrable unique `(pipeline, position)` for atomic reorders |
| `apps/deals` | new app | Deals, append-only stage history, product lines (price snapshots), deal contacts; `move_stage` is the locked/versioned/audited path; `board` endpoint |
| `apps/notes` | new app | Notes (author-owned) + record timeline with a provider registry (Phase 3 activities plug in) + `resolve_viewable` (entity id → record within the actor's view scope, 404 otherwise) |
| `apps/search` | new app | PostgreSQL full text (`websearch_to_tsquery`, `simple` config) through `authz.scope()` per entity |
| `apps/importexport` | new app | CSV upload hardening, mapping validation, background import/export tasks rebuilt from the requester's membership, private storage, formula neutralisation |

Database: 15 new tenant tables, all with forced RLS (`rls_check`: 24/24 tables protected); append-only trigger on `deals_dealstagehistory`; `deals_deal_stage_matches_pipeline` trigger (a deal's stage must belong to its pipeline and organization); search-vector triggers on contacts, companies, products, deals; GIN indexes.

Permission catalogue additions (reviewed): `pipelines.view/manage`, `customfields.view/manage`, `tags.view/manage`, `notes.view`. Sales Manager gained `pipelines.manage` and `tags.manage`; every role reads pipelines, custom-field definitions and tags.

## 2. Deviations from the Phase 0 design (all documented in the gate report)

- **Saved views and attachments** are not in this phase (the prompt's Phase 2 list did not include them; attachments need the object-storage/AV decisions of Phase 6). Saved views ride on the URL-backed list state for now.
- **Exchange rates**: ADR-0012's per-organization rate table is deferred to Phase 3 reporting; deals accept an explicit `exchange_rate` (default 1) and store `amount_base` at write time as designed.
- **Bulk operations** run synchronously up to 500 ids (the API design said enqueue above 50); the per-record scope pre-check and audit are as designed. Async bulk arrives with the Phase 3 job framework.
- **Import/export storage** is a private filesystem root (`PRIVATE_STORAGE_ROOT`) behind an authenticated, audited download endpoint instead of S3 signed URLs; the storage module has the two functions Phase 6 will point at object storage.
- **Deal import** is not offered (imports: contacts, companies, products; exports also deals), matching the phase plan.
- **Custom field count**: 14 types instead of "13" (integer and decimal are separate).

## 3. Tests

Backend: 311 tests (124 from Phase 1 + 187 new) covering CRUD/validation, filters/sorts, concurrency (incl. a threaded race), role × ownership matrices for contacts/companies/deals, settings routes per role, reassignment rules, cross-tenant probes generated for all 16 new viewsets, forged organization/owner/foreign-reference payloads, custom-field validation and filter hardening, notes/timeline visibility, search scoping and hostile input, CSV upload hardening, import end-to-end with error rows, export scoping/neutralisation/requester-only download, XSS/SQLi/filter-injection payloads, mass assignment, version-header hardening, and the critical business workflow.

Frontend: vitest component tests for the new forms, kanban fallback, global search and settings pages plus the Phase 1 suites; `tsc --noEmit`, eslint, `next build`.
