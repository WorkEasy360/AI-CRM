# Milestone 2 (Core CRM): gap audit

Audited against the code on `feat/android-twa` (M1 complete, uncommitted) on 2026-10-18, before any M2
feature code was written. "Present" means it is in the code and wired to the API and UI, not just a model.

**Status at the end of M2: every row is resolved** — built, kept as a recorded divergence (DECISIONS M2.x),
or deferred to a named milestone.

**States:** ✅ present and spec-compliant · 🟡 present but divergent (how) · ❌ missing.
**Resolution** says what M2 does with the row: *built* (M2 builds the gap), *kept* (production behaviour
kept, divergence recorded in DECISIONS.md as M2.x), or *deferred* (the milestone that lands it).

## A. Modules and records

| Capability | State before M2 | Resolution |
|---|---|---|
| Contacts, Companies, Products, Deals modules | ✅ `apps/contacts`, `companies`, `products`, `deals` on the shared `apps.crm.records` lifecycle (create/update/archive/restore/bulk, versioned, audited, events) | kept |
| Activities: Tasks, Events, Calls | 🟡 one `Activity` table with kinds `task`, `call`, `meeting`. The spec's "Event" is the existing `meeting` kind | kept: the API kind stays `meeting`, the UI says "Event" (M2.10) |
| Notes on any record | 🟡 contacts, companies, deals, products. Not activities | built: activities added |
| Attachments on any record | 🟡 same four modules. Not activities | built: activities added |
| Tags on any record | 🟡 same four modules. Not activities | kept: activities are not tagged (M2.11) |
| Record-limit definition consistent everywhere | 🟡 M1.4 defines it (non-archived contacts + companies + deals + products). Every API path goes through `entitlements.consume/release`. The usage page shows one total with no breakdown or definition. Imports cannot roll back yet | built: per-module breakdown and the definition on Settings → Plan & usage; rollback releases its slots (M2.1) |

## B. Pipelines

| Capability | State before M2 | Resolution |
|---|---|---|
| Multiple independent pipelines, own stages | ✅ `Pipeline` + `PipelineStage`, limit-checked through `entitlements.check_capacity("pipelines")` | kept |
| Own layout per pipeline | ❌ | built: `Pipeline.layout` (card and form field keys, validated against the module schema) |
| Per-pipeline access by team or role | ❌ every pipeline is visible to every member with `deals.view` | built: `PipelineAccess` rules (team / hierarchy role), enforced by the authz scope filter registry on every deal read path |
| Sub-pipelines | ❌ | built: `Pipeline.parent`; variants share the parent's layout and access with their own stage set (M2.4) |
| Stages ordered, typed open/won/lost, probability | ✅ | kept |
| Connected pipelines: link model, manual linking, bidirectional display | ❌ | built: `DealConnection` + endpoints + a deal-page section; `connections.create_connected_deal()` is the hook for M5 |
| Stage-transition validation hook | ❌ | built: `apps.pipelines.transitions` registry with a pass-through stub validator, called from `move_stage` (Kanban drag, stage dialog, Sheet edits and imports all route through it) |
| Kanban drag-and-drop | ✅ HTML5 drag, optimistic, versioned | kept |
| Kanban inline edit | ❌ | built: inline name / amount / close-date edit on a card |
| WIP counts, stage value totals | ✅ server-side counts and totals | kept |
| Weighted forecast per stage | 🟡 computed client-side and only shown when a column is fully loaded | built: server-side weighted total per stage plus the pipeline total |
| Virtualized board, 1,000 deals < 1 s | 🟡 hard cap of 50 cards per stage ("see the list for the rest"), no virtualization | built: per-stage paging plus windowed columns; load-tested |
| Default pipeline templates of our own | 🟡 one default stage set whose wording overlaps common CRM defaults | built: five original templates; new organizations get the new "Sales" template; existing pipelines untouched |

## C. Products and line items

| Capability | State before M2 | Resolution |
|---|---|---|
| Catalog with SKU, tax | ✅ | kept |
| Price books | ❌ | built: `PriceBook` + `PriceBookEntry`; a deal may name a price book and lines take its price |
| Stock flag | ❌ | built: `Product.in_stock` |
| Line items: quantity, discount, tax | 🟡 stored, but `line_total` ignores tax, and lines neither bump the deal version nor emit events | built: subtotal / tax / total per line, version bump + event + audit |
| Deal amount auto-computed from lines | ❌ the amount is always manual | built: a deal with lines has a computed amount; a manual amount is refused while lines exist (M2.6) |
| Line-item field permissions | ❌ | built: new field-rule module `deal_line`; a hidden deal `amount` also hides line money |

## D. Activities

| Capability | State before M2 | Resolution |
|---|---|---|
| Tasks: priority, due date, reminder | ✅ | kept |
| Task subtasks | ❌ | built: `Activity.parent` (one level, tasks only) |
| Task recurrence | ❌ | built: RRULE on the task; completing an occurrence creates the next one |
| Events: start/end, all-day, location, attendees | ✅ (`meeting`) | kept |
| Event RRULE recurrence | ❌ | built: validated RRULE, expanded into occurrences by the calendar API |
| Calls: direction, outcome, duration, notes; scheduled and logged | ✅ (open = scheduled, completed = logged) | kept |
| Bulk reassign | ❌ | built: `POST /activities/bulk/` (reassign, complete); audited, events per activity |
| "My day" view | ❌ | built: `GET /activities/my-day/` + page |
| External calendar sync, telephony | not in scope | deferred M4 |

## E. Record page

| Capability | State before M2 | Resolution |
|---|---|---|
| 360° timeline | 🟡 pluggable provider registry exists (notes, stage history, activities, email/WhatsApp, lifecycle, field changes) but: capped at 200 merged events with no paging, files missing, field-change rows name fields that may be hidden | built: cursor paging (`before`), file source, named source registry (`/timeline/sources/`), hidden fields filtered from field-change rows |
| Payments, form submissions | not built yet | deferred M6: they register a timeline source, no redesign needed |

## F. Views

| Capability | State before M2 | Resolution |
|---|---|---|
| Saved views (filters, columns, sharing, per-user default) | ❌ no saved views at all | built: `apps.savedviews` |
| List view | 🟡 lists with filters exist, fixed columns, nothing saved | built: column selection and saved state |
| Kanban view | 🟡 deals only (board by stage) | built: deals by stage plus a generic group-by Kanban (contacts by lifecycle stage or any choice field) |
| Sheet view | ❌ | built: windowed grid API, batch cell edits, paste, fill-down |
| Calendar view | 🟡 activities calendar only | built: records by any date field (contacts, deals) plus events, task due dates and scheduled calls |
| Chart view | ❌ (dashboards only) | built: one grouped bar chart per view; full dashboards M7 |
| Runtime-describable module schema | ❌ field lists hard-coded in serializers, import and export | built: `apps.crm.schema` registry + `GET /schema/{entity}/`, which drives sheet, views, import targets and export columns |

## G. Search

| Capability | State before M2 | Resolution |
|---|---|---|
| Cross-module search honouring the role hierarchy | ✅ PostgreSQL FTS through `authz.scope()` | kept: no OpenSearch (G4, M2.15) |
| Search honouring field permissions | ❌ result subtitles show email, phone and amount even when hidden; matching uses hidden fields | built: masked summaries; hidden searchable fields drop the actor to visible-field matching |
| Filters and sorts honouring field permissions | ❌ `?amount_min=` and `?sort=amount` work on a hidden amount (an oracle) | built: `FilterSet` refuses filters and sorts on hidden fields |

## H. Import, export, migrate

| Capability | State before M2 | Resolution |
|---|---|---|
| CSV import with column mapping | ✅ contacts, companies, products; batched, resumable | kept |
| XLSX import | ❌ | built (`openpyxl`, read-only mode, first sheet) |
| Deal import | ❌ | built (pipeline and stage by name) |
| Dedupe on import | ❌ | built: skip / update / create-anyway, on email (contacts), name or website (companies), SKU (products), name + pipeline (deals) |
| Validation preview before commit | 🟡 preview shows the first 5 raw rows only | built: full dry-run (counts to create, update, skip and fail, plus per-row errors) |
| Import rollback | ❌ | built: per-row references and before-values; conflicts reported, counters corrected, audited as a rollback |
| Clean stop at the record limit | ❌ a limit hit mid-run was recorded as one error per remaining row and the job carried on | built: stops at a consistent checkpoint and names the plan or add-on |
| Migration presets (Zoho CRM, HubSpot, Pipedrive) | ❌ | built: header-mapping presets |
| Full export obeying field permissions and hierarchy | 🟡 per-module CSV export obeys both; no export of everything | built: "all modules" export (ZIP of per-module CSVs) |

## Cross-cutting

| Constraint | State before M2 | Resolution |
|---|---|---|
| Domain events on every mutation | 🟡 records yes; deal lines, activity deletes and bulk paths partly | built for every M2 mutation |
| RLS + tenant isolation tests per new table and endpoint | n/a | built: RLS policy per new table, `CROSS_TENANT_FACTORIES` + explicit isolation tests |
| Money currency-aware | ✅ deals carry `currency`, `exchange_rate`, `amount_base`; lines carry `currency` | built: price books and line totals carry currency too |
| Dashboards / forecast / AI field masking | known gap M1.19 | deferred M7 / M8 |
