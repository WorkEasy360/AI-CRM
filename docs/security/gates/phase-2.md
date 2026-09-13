# SECURITY GATE — Phase 2 (CRM Core)

Date: 2026-09-13. Scope: companies, contacts, products, pipelines + stages, deals (stage moves, history, product lines, contacts, board), custom fields, tags, notes + record timeline, tenant-scoped global search, CSV import/export, and the frontend for these modules. Reviewer: implementing engineer (self-review against `docs/security/threat-model.md`); product-owner approval pending. Phase 1 gate approved 2026-09-13.

## 1. Attack surface introduced

| Surface | Endpoints / components |
|---|---|
| Record collections | `/api/v1/{contacts,companies,products,deals}/` list/create, `/{id}/` retrieve/update/archive, `/{id}/restore/`, `/{id}/tags/`, `/count/`, `/stats/` (contacts, companies), `/bulk/` (contacts, companies, deals) |
| Deals | `/deals/board/`, `/deals/{id}/stage/`, `/history/`, `/products/` (+ `add`, `{line}`, `{line}/remove`), `/contacts/` (+ `add`, `remove`) |
| Pipelines | `/pipelines/` CRUD, `/pipelines/{id}/stages/`, `/stages/reorder/`, `/stages/{id}/` |
| Settings | `/custom-fields/` (+ `restore`), `/tags/` |
| Notes / timeline / search | `/notes/`, `/notes/{id}/`, `/timeline/`, `/search/` |
| Files | `/imports/{contacts,companies,products}/` (multipart upload, preview, start), `/exports/{contacts,companies,products,deals}/` (create, list, download) |
| Background | Celery tasks `importexport.run_import`, `importexport.run_export` (tenant-bound, actor rebuilt from the requester's membership) |
| Database | 15 new tenant tables with forced RLS, 4 search-vector triggers, append-only trigger on stage history, stage/pipeline consistency trigger |
| Frontend | Contacts/Companies/Products tables + detail pages, Pipeline kanban + list, deal detail, settings for pipelines/custom fields/tags/data (import/export), global search (Ctrl+K), quick-add |

## 2. Threats identified

Register entries addressed: T1 (IDOR/BOLA across every new relation), T8 (mass assignment, version/owner/organization smuggling), T10 (XSS via CRM text and custom values), T11 (unauthorised bulk export), T12 (CSV formula injection, malicious imports), T13 (upload attacks: extension/size/binary/NUL/row caps), T19 (unbounded queries: cursor pagination caps, per-type search limits, board caps, export row cap), T20 (background jobs bound to tenant and requester). New entries added during implementation: **T36** (concurrent stage moves; a real defect was found by the race test and fixed), **T37** (custom fields as a validation/authorisation bypass), **T38** (CSV import hardening), **T39** (export/search widening scope).

## 3. Security controls implemented

- **Tenant isolation**: every new model inherits `TenantModel` (immutable `organization_id`, fail-closed manager); `rls_check` passes on all 24 tenant tables; foreign keys are validated through tenant-scoped querysets (`TenantPrimaryKeyRelatedField`), so an id from another organization fails validation (400) and a record from another organization answers 404 on every detail route (router-generated test).
- **Authorization**: `CrmViewSet` looks records up within the *view* scope, then `check()`s the action's permission on the object (404 outside scope, 403 without rights); every service re-checks on the loaded object; `records.resolve_owner()` refuses reassignment unless the actor holds `deals.reassign` or update at scope `all` (`403 reassign_denied`); bulk actions compute the scoped set first and refuse the whole request when any id is outside it (`400 bulk_out_of_scope`); notes and the timeline resolve the parent record within the actor's view scope (`resolve_viewable`); search runs each entity through `authz.scope()`; exports re-apply `scope()` inside the task with the requester's actor and are downloadable only by the requester; import rows are created with the requester as owner through the same serializers and services as the API.
- **Concurrency**: `version` on every record; `If-Match` or body `version` required for updates and stage moves (428 when missing, 409 on mismatch); stage moves lock the deal row alone (`SELECT … FOR UPDATE OF deal`), compare the version under the lock and update with `WHERE version = ?`; history and audit are written in the same transaction; a threaded race test proves exactly one of two concurrent moves wins.
- **Input validation**: explicit input serializers (no `ModelSerializer` writes), allowlisted filters/sorts with 400 on unknown keys, http(s)-only URLs (rejects `javascript:`/`data:`/credential-bearing URLs), control characters stripped and NUL bytes refused, length caps on every text field, decimal caps and non-negative checks, ISO-4217 currency shape, address object key allowlist, custom-field values coerced per declared type with a 64 KB payload cap and reserved-key protection, CSV upload caps (5 MB, 10 000 rows, 60 columns, 5 000-char cells, UTF-8, no NUL), mapping allowlist (targets only; `owner_id`/`organization_id` unreachable), search query cap (200 chars), per-type result cap (20).
- **Output handling**: JSON only; CSV exports neutralise `= + - @ \t \r |` cells and are served with `Content-Disposition: attachment`, `nosniff`, `no-store`; custom values only exposed for active definitions; owner/author refs carry `{id, display_name}` only.
- **Audit**: every create/update/reassign/archive/restore/bulk/stage move/product line/contact link/note/tag/definition/pipeline change/import upload+start+completion/export request+completion+download writes an audit event through `audit.record()` (redacted, append-only).
- **Background processing**: imports and exports always run as Celery tasks (`tenant_task`) after commit; the actor is rebuilt from the requester's membership and re-checked; jobs are requester-scoped; the import file is deleted after processing; exports expire after 24 h.
- **Rate limiting**: `search` scope (120/min), `sensitive` scope on import/export routes, `admin` scope on custom-field management; existing user/anon throttles elsewhere.
- **Supply chain**: all GitHub Actions pinned to commit SHAs (G4 closed); the Phase 1 workflow referenced a non-existent Trivy action tag (`0.28.0`), corrected to the `v0.36.0` release SHA.

## 4. Authorization checks implemented

`permission_map` on every new viewset/view (route-coverage test); 16 new viewsets probed cross-tenant by the generated test; role × ownership × operation matrix for contacts, companies and deals (11 cases × 3 modules × retrieve/patch/archive), create per role, product create per role, settings routes per role (pipelines, custom fields, tags, search, exports, imports, bulk, board), stage-move authorisation (rep own → 200, rep other → 404, viewer → 403), reassignment rules, notes author scope, export/import permissions per role.

## 5. Tenant-isolation checks

Generated cross-tenant probes for every new viewset (all detail routes → 404, lists exclude foreign ids); forged `organization_id`, `owner_id`, `version`, `archived_at`, `id` in payloads; foreign company/contact/pipeline/stage/product/tag/import/export ids across every relation; foreign records via notes, timeline, board, stage management; search and export never include another organization's rows; RLS on all new tables verified by `rls_check` and by the raw-SQL tests from Phase 1.

## 6. Input-validation checks

Invalid emails/phones/URLs/addresses/lengths/sizes/currencies/rates rejected; `javascript:` URLs rejected in built-in and custom fields; every custom-field type validated (14 types) incl. unknown keys, reserved keys, operator-like keys, oversized payloads, required fields on create and partial update; filter and sort injection (`sort=owner__user__password`, JSONB path smuggling, non-UUID ids, bad dates, NaN) → 400; XSS and SQL payloads across all text fields stored as text and returned as JSON; CSV: wrong extension, empty, binary/NUL, non-UTF-8, no data rows, duplicate headers, ragged rows, too many columns/rows, oversized cells, oversized file, wrong field name → 400; export cells beginning with formula triggers are neutralised.

## 7. Tests written

| Suite | Tests |
|---|---|
| Phase 1 suites (unchanged) | 124 |
| `tests/crm/test_records.py` (CRUD, validation, filters/sort/count/stats, tags, bulk) | 7 |
| `tests/crm/test_pipelines_deals.py` (pipelines/stages, deal rules, stage moves, race, lines/contacts, board) | 8 |
| `tests/crm/test_customfields.py` | 6 |
| `tests/crm/test_notes_timeline_search.py` | 3 |
| `tests/crm/test_importexport.py` (upload hardening, import e2e, permissions, scoped export, neutralisation) | 16 |
| `tests/crm/test_workflow.py` (critical business workflow) | 1 |
| `tests/authz_matrix/test_crm_matrix.py` (matrix, create, products, settings routes, reassignment) | 114 |
| `tests/tenant_isolation/test_crm_smuggling.py` | 4 |
| `tests/tenant_isolation/test_generated.py` (now 22 viewsets) | +16 |
| `tests/security_regression/test_crm_payloads.py` | 12 |
| **Total backend** | **311, all passing** (`uv run pytest`) |
| Frontend vitest (form dialogs for contacts/companies/products/deals, kanban fallback + conflict handling, global search, custom-fields dialog) | 33 new, 65 total, all passing |

## 8. Remaining vulnerabilities and gaps

| # | Item | Severity | Status |
|---|---|---|---|
| G1 | WebAuthn/passkey enrolment UI still missing (from Phase 1) | Low | Phase 3 |
| G2 | Suspicious-login detection IP/UA only (from Phase 1) | Low | Phase 6 |
| G3 | Client-side route gating (from Phase 1) | Low | Phase 6 proxy |
| G5 | `auth.login_failed` stores the attempted email (from Phase 1) | Low | Phase 6 retention |
| G9 | Import/export files live on the API container's filesystem (`PRIVATE_STORAGE_ROOT`) instead of private object storage; multi-instance deployments need a shared volume until Phase 6 moves this to S3 with signed URLs | Low (dev/staging) | Phase 6 |
| G10 | Bulk operations are synchronous up to 500 ids (design said async above 50); bounded by the id cap, statement timeout and throttles | Low | Phase 3 job framework |
| G11 | No JSONB expression indexes for custom-field filters yet (performance, not security) | Info | when latency requires |
| G12 | Import files are accepted up to 5 MB after Django has buffered the request; the Nginx `client_max_body_size 10m` limit applies in staging/production, not in `runserver` | Info | documented |
| G13 | Semgrep and gitleaks run via Docker locally (no Windows builds) | Info | documented |

No open Critical or High findings.

## 9. Dependencies introduced

None. Phase 2 uses only the Phase 1 dependency set (Django's `django.contrib.postgres` app was enabled for full-text search; it ships with Django). Frontend: no new packages (drag-and-drop uses native HTML5 events).

## 10. Security scan results

| Scan | Result |
|---|---|
| pytest (311 tests incl. isolation, matrices, race, payload suites) | pass |
| `manage.py rls_check` on migrated database | pass (24/24 tables forced RLS + policy) |
| `makemigrations --check` | in sync |
| ruff (lint + format, security rules `S`, Django `DJ`, bugbear) | 0 findings |
| mypy | 0 errors (164 files) |
| bandit (`apps config security`) | 0 findings |
| pip-audit `--strict` | no known vulnerabilities |
| gitleaks (working tree) | no leaks |
| Semgrep `p/django` + `p/python` + project rules on `backend/` | 0 findings, 172 files scanned, 0 errors |
| Trivy on `keel-backend` image (HIGH/CRITICAL, fixable) | 0 findings (Debian 13.7 base, 51 Python packages clean) |
| Frontend `pnpm audit --audit-level=high` | no known vulnerabilities |
| Frontend eslint (incl. `react/no-danger`, `no-eval`), `tsc --noEmit`, vitest, `next build` | all pass: 0 lint findings, 0 type errors, 65 tests in 11 files (32 from Phase 1 + 33 new), 26 routes built (8 new); grep for `dangerouslySetInnerHTML`, `eval`, `innerHTML`, `localStorage`, `NEXT_PUBLIC_` in `src/`: none |
| Trivy on `keel-frontend` image (HIGH/CRITICAL, fixable) | 0 findings (Alpine 3.24.1 base, all bundled Node packages clean) |

## 11. Vulnerabilities found and fixed during this phase

| Finding | Severity | Fix |
|---|---|---|
| Scheme-less URL normalisation turned `javascript:alert(1)` into `https://javascript:alert(1)` (accepted for company websites and URL custom fields; a stored link could execute script on click in clients that honour it) | High (found by tests) | `clean_url` rejects any input with a scheme other than http/https before prefixing `https://` |
| Required custom fields were skipped when a client omitted `custom_data` entirely (validation bypass) | Medium | `records.create` validates an empty payload against the definitions when the key is absent |
| Notes answered 403 instead of 404 for a note on a record outside the actor's view scope (existence leak) | Medium | `NoteViewSet.get_object` resolves the parent record within the view scope first |
| `CrmRecord` inherited `OWNER_FIELD = None` from `TenantModel` ahead of `OwnedModel`, so own/team scopes evaluated to nothing (reps could not see their own records: fail closed, but a functional break of the scope model) | Medium | `OWNER_FIELD = "owner"` restated on `CrmRecord`; covered by the matrix tests |
| Concurrent stage moves: the loser of the row lock received 404 instead of 409 because `select_for_update` joined the stage row and PostgreSQL's EvalPlanQual re-check dropped the row after the winner changed `stage_id` | Medium (correctness; no double-apply was possible) | lock the deal row alone (`select_for_update(of=("self",))`), load related rows afterwards; race test asserts `[200, 409]` and exactly one history row |
| `has_company` filter semantics were inverted | Low | new `has` filter kind |
| Multipart parser was selected by action before DRF had resolved the action, so CSV uploads answered 415 | Low | static `parser_classes = [JSONParser, MultiPartParser]` |
| CI referenced `aquasecurity/trivy-action@0.28.0`, a tag that does not exist (the container job would have failed on GitHub) | Low | pinned to the `v0.36.0` release SHA together with every other action |

## 12. Risks accepted

- Shared-schema tenancy with RLS as defence in depth (ADR-0002).
- `system_context()` as an in-process bypass (T34), unchanged: no new `all_objects` use sites were added in Phase 2 (`grep`-verified; Semgrep rule still confines it).
- G9–G13 above, with owners and phases assigned.
- Exchange rates are client-supplied per deal (validated positive, ≤ 1 000 000) until the Phase 3 rate table; `amount_base` is a write-time snapshot as designed.

## 13. Safe to continue?

**Yes, pending product-owner approval.** No Critical or High finding is open in code, dependencies, secrets or container images. One High (scheme-less `javascript:` URL normalisation) and four Medium issues were found by the Phase 2 test suites and fixed before this gate (§11). Remaining items G1–G3, G5, G9–G13 are Low/Informational with owners and phases assigned.

Phase 3 (sales operations) does not start without the product owner's explicit approval of this document.
