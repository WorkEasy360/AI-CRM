# WorkEasy360 CRM: gap report against the reference screens

- Audit date: 2026-11-05, baseline commit `d9cce50` (branch `release/bigin-m1-m2`).
- Reference screens: Dashboard, Pipeline, Contacts, Activities, AI Assistant, Helpdesk, Settings.

**Legend**

| Mark | Meaning |
|---|---|
| ✅ | Exists and matches |
| 🟡 | Exists, needed an update |
| ❌ | Missing |
| ⏭ | Deliberately built differently (see Decisions) |

The **Status** column records the audit result. The **Final** column records the state after the work, with the commit that delivered it.

## Stack found

- **Backend:** Django + DRF modular monolith (`backend/apps/*`). PostgreSQL with RLS and fail-closed tenant managers. Celery + Redis (beat schedules reminders and automation sweeps).
- **Frontend:** Next.js 15 App Router, React Query, Tailwind v4 with `--kl-*` design tokens, Radix primitives (`components/ui/*`), vitest.
- **Auth and authorization:**
  - Session auth.
  - `authz.scope` / `check` role grants at own, team or all scope.
  - Re-authentication for sensitive changes.
  - Audit log in `apps.audit`.
- **AI:** Anthropic provider router (`apps/ai/providers`). Requests go from deterministic intent to scoped SQL tools, and the model receives the results as evidence (`apps/assistant`). Quotas live in `apps/ai/budgets.py`.

## Reusable pieces found

- **Page chrome:** `PageHeader`, `KpiTile` / `percentChange` (dashboard/stat-tile), `Sheet` (slide-over), `Tabs`.
- **Lists:** `DataTable` + `BulkBar` + `use-cursor-list`, `ListToolbar`, `ViewBar` (saved views: list / kanban / sheet / calendar / chart).
- **Records:** `QuickActions` (call, email, WhatsApp and meeting on a record), `TagPicker`, `DuplicateWarning`, `formatMoney`.
- **Backend services:** `notifications.notify`, `messaging.send_whatsapp` / email, `audit.record`, `storage` (private blobs).

## Main tables/models found

- **Accounts:** Organization, Membership, Role, Team.
- **CRM records:** Contact, Company, Deal, DealStageHistory, DealProduct, Pipeline, PipelineStage, Product, PriceBook.
- **Activities and content:** Activity (task / call / meeting), Note, File, Tag.
- **Messaging:** EmailMessage, WhatsAppMessage, templates.
- **Helpdesk and automation:** Ticket, AutomationRule / AutomationRun, Notification.
- **AI:** Conversation / ConversationTurn, AIUsage.
- **Integrations:** ApiCredential, WebhookSubscription, OutboundDelivery.
- **Platform:** AuditEvent, SavedView, CustomField.

## Commits

| Module | Commit |
|---|---|
| Phase 0 report | `5190e45` |
| Phase 1 shell | `9e32ccc` |
| Settings | `fce2a6a` |
| Helpdesk | `1acad5c` |
| Pipeline | `fda7650` |
| Dashboard | `613e22d` |
| Activities | `80874e1` |
| Contacts | `989ae36` |
| AI Assistant | `d40cc4a` |

---

## Phase 1: global layout

| Feature / UI element | Status | Work done | Final |
|---|---|---|---|
| Dark green sidebar, green active pill, logo + CRM pill | ✅ | — | ✅ |
| Nav order Dashboard…Settings | 🟡 | Spec order kept. The existing Products item and People/Companies sub-items stay. | ✅ |
| "WorkEasy AI" promo card + Ask AI Now → | ❌ | `AiPromoCard` at the sidebar bottom; the profile moved to the avatar menu | ✅ |
| Global search incl. tickets | 🟡 | Ticket target, scoped by `tickets.view`, matched by subject, requester or `#TK-number`; new placeholder | ✅ |
| + Create incl. Ticket | 🟡 | Ticket opens the Helpdesk create panel (`?new=1`) | ✅ |
| WhatsApp top-bar button | ❌ | Links to the Activities WhatsApp tab (needs `whatsapp.view`) | ✅ |
| Bell with red dot + dropdown | 🟡 | Red unread dot; the count stays in the accessible name | ✅ |
| Help (?) and avatar menu | ✅ | — | ✅ |
| Page header with large icon | 🟡 | `PageHeader icon=` used on every module | ✅ |
| KPI tile with trend | ✅ | Purple, pink and red tones added; `lowerIsBetter` for durations | ✅ |
| Tabs with counts | 🟡 | Counted pill tab bars on Helpdesk, Contacts, Activities and Pipeline | ✅ |
| Data table checkboxes + ⋮ | 🟡 | ⋮ menus and selection on the new tables | ✅ |
| Numbered pagination | 🟡 | "Showing 1–N" plus Load more | ⏭ D1 |
| Right slide-over panel | ✅ | Ticket, Deal Details and Add Contact panels | ✅ |
| INR lakh formatting | 🟡 | INR always uses `en-IN` grouping without paise; `formatCompactMoney` gives L / Cr on chart axes | ✅ |

## 1. Dashboard

| Feature / UI element | Status | Work done | Final |
|---|---|---|---|
| Greeting "Good Afternoon, Manoj! 👋" + subtitle | 🟡 | Wording, casing and emoji | ✅ |
| Month selector filtering the dashboard | 🟡 | `period=YYYY-MM` (any started month) alongside the presets; the default is the current month | ✅ |
| KPIs: Contacts, Companies, Deals, Expected Revenue, Win Rate + trend | 🟡 | `totals` with growth since the window start; expected revenue is the weighted open pipeline | ✅ |
| Sales Pipeline Overview tiles, clickable | 🟡 | Tinted tiles linking to `/pipeline?view=list&stage=…` | ✅ |
| Revenue Trend bars + line, 3/6/12 months, total, growth | 🟡 | `months` parameter; bars and a line on one axis | ✅ |
| Today's Agenda | ❌ | Timeline from `activities/my-day` | ✅ |
| Upcoming & Overdue | 🟡 | Overdue, due this week, and deals closing this week (new count) | ✅ |
| Key Business Summary incl. Open Tickets | 🟡 | Activities logged by kind against the previous period; open tickets | ✅ |
| Deals by Source donut | ❌ | `deals_by_source`, with fixed per-source hues (validated) | ✅ |
| Top Performing Team | 🟡 | Won deals and revenue per owner in the window | ✅ |
| Recent Activities | ❌ | Latest updated activities | ✅ |
| Quick Actions ×8 | ❌ | Real forms and pages, each gated by permission | ✅ |
| WorkEasy AI Insights | ❌ | Computed `insights`: follow-ups today, deals close to winning, win-rate change, deals with no next step, tickets past SLA | ✅ |

## 2. Pipeline – Leads & Deals

| Feature / UI element | Status | Work done | Final |
|---|---|---|---|
| Title + subtitle | 🟡 | Fixed title; the pipeline name moved to the selector | ✅ |
| KPIs incl. Avg. Deal Cycle + trends | ❌ | `deals/pipeline-stats/` compares against the previous 30 days | ✅ |
| Tabs Kanban / List / Forecast / Analytics | 🟡 | Forecast embeds the existing forecast; Analytics uses `deals/analytics/` | ✅ |
| Filters: pipeline, owners, sources, products | 🟡 | `lead_source`, `priority` and `product` (subquery) filters | ✅ |
| Deal priority / source | ❌ | Migration `deals 0010` | ✅ |
| Kanban card: priority, owner name, won check | 🟡 | Done | ✅ |
| Column count badge + total | 🟡 | Done | ✅ |
| Per-column + Add Deal | ❌ | `defaultStageId` creates the deal in that stage; the server checks the stage belongs to the pipeline | ✅ |
| Drag & drop + history | ✅ | — | ✅ |
| Dashed drag hint | ❌ | Done | ✅ |
| Deal Details panel | ❌ | Slide-over with stage select, inline value / close date / owner / source, products, Activities / Notes / Files, quick actions and Move to Next Stage | ✅ |

## 3. Contacts

| Feature / UI element | Status | Work done | Final |
|---|---|---|---|
| Subtitle + KPIs | ❌ | `contacts/stats` adds favourites, tagged, new vs previous, and company counts | ✅ |
| Favorites | ❌ | `Favorite` model (`tagging 0003`, RLS, per member); `POST /favorites/` only for viewable records | ✅ |
| Tabs All / Individuals / Companies / Favorites / Tags | 🟡 | All = people + companies interleaved; Individuals = the full existing list with saved views | ✅ (D2) |
| + Add Contact dropdown | 🟡 | Individual, Company, Import | ✅ |
| Tag filter | ❌ | `?tag=` on contacts and companies | ✅ |
| Table columns (avatar, Type, WhatsApp, Tags, Last activity) | 🟡 | All Contacts table | ✅ |
| Row actions incl. Favorite | 🟡 | Favourite on both tables. Delete stays as archive. | ✅ (D3) |
| Bulk tag / assign / archive | ✅ | Existing bulk bar on Individuals | ✅ |
| Bulk export from the bar | 🟡 | Export stays in Settings → Import & Export | ⏭ |
| Add Contact slide-over | 🟡 | Individual / Company toggle, company search with inline create, +91 code, tags, notes, duplicate hints | ✅ |
| Contact detail: tickets | 🟡 | Tickets tab | ✅ |

## 4. Activities

| Feature / UI element | Status | Work done | Final |
|---|---|---|---|
| Subtitle | ❌ | Done | ✅ |
| KPIs + trends | 🟡 | `summary.totals` and `summary.created` (last 30 days vs the 30 before) | ✅ |
| Follow-ups tab | 🟡 | `follow_up=1`: open calls with a follow-up outcome, or open activities titled as follow-ups | ✅ (D4) |
| Filters: type, status, owner, date range, list/calendar | 🟡 | Today / This Week / This Month / Custom | ✅ |
| Table with Related To, Owner, red due, status, ⋮ incl. Reschedule | 🟡 | `ActivityTable`; the grouped list (bulk, subtasks) is one toggle away | ✅ |
| Right column | ❌ | Today's Schedule, mini calendar filtering by day, Upcoming, Overdue | ✅ |
| Form + reminders | ✅ | — | ✅ |
| "Scheduled" status | 🟡 | Display label only | ✅ (D5) |

## 5. AI Assistant

| Feature / UI element | Status | Work done | Final |
|---|---|---|---|
| Header, subtitle, "Powered by AI" | 🟡 | Done | ✅ |
| Inline chat with green bubbles + avatars | 🟡 | The thread renders on the page (`setInline`); the side panel stays for other pages | ✅ |
| Summary card + today's follow-ups | 🟡 | From dashboard (7 days), activity summary and my-day | ✅ |
| AI Suggestion banner + View Leads | ❌ | First computed insight | ✅ |
| Suggestion chips | 🟡 | The four spec chips; "Create a task" opens the real form | ✅ |
| Mic voice input | ❌ | Web Speech API where available; audio is handled by the browser | ✅ |
| Real data, scoped, persisted history | ✅ | — | ✅ |
| AI Quick Actions ×8 | 🟡 | Spec set; creation actions open real forms | ✅ |
| AI Insights & Recommendations | ❌ | Computed insights with links | ✅ |
| Recent AI Actions | ❌ | Built from saved conversations (`Conversation` model), not a new `ai_actions` table | ⏭ D8 |
| Usage limits | ✅ | — | ✅ |

## 6. Helpdesk

| Feature / UI element | Status | Work done | Final |
|---|---|---|---|
| KPIs incl. Overdue and Avg. Resolution | 🟡 | Extended `summary` with the previous 30 days | ✅ |
| Tabs with counts | ❌ | Done | ✅ |
| Filters: priority, category, agent, product, ID search | 🟡 | Migration `helpdesk 0003` adds category and product; `#TK-1045` search | ✅ |
| Ticket ID `#TK-XXXX` | 🟡 | Done | ✅ |
| Category with icon, Company, ⋮, relative Updated | ❌ | Done | ✅ |
| Ticket Details panel with inline editing | ❌ | Done | ✅ |
| Conversation / Internal Notes / Activity | ❌ | `TicketMessage` (RLS); the activity view comes from the ticket's audit trail, without IPs | ✅ |
| Reply box (attachment, emoji, send by email/WhatsApp) | ❌ | Sending goes through the messaging services, so the mailbox, consent, 24-hour window and plan checks all apply | ✅ (D6) |
| Mark as Resolved, More (Reassign, Priority, Merge, Close, Delete) | 🟡 | Merge moves the thread and closes the source | ✅ (D7) |
| SLA due from priority, overdue | ❌ | Per-priority hours in org settings (changing them needs `org.update`); overdue is computed live | ✅ |

## 7. Settings

| Feature / UI element | Status | Work done | Final |
|---|---|---|---|
| Landing 3×2 card grid | ❌ | `SettingsIndex` grid, filtered by permission; Automation, Billing and Price books sit below the grid | ✅ |
| All sub-pages | ✅ | Usage & Limits links to the AI usage section | ✅ |

## Phase 3: cross-module

| Item | Final |
|---|---|
| Contact ↔ Company ↔ Deal ↔ Activity links | ✅ |
| Contact ↔ Ticket | ✅ Tickets tab; ticket shows the requester's company |
| Writes audited; notifications and webhooks | ✅ New writes audit (`tickets.*`, `tickets.sla_updated`). Favourites are personal preferences and are not audited. |

---

## Decisions

- **D1 Pagination.**
  - Every list API uses cursor pagination, which stays correct and fast on large tenants.
  - Lists show "Showing 1–N of total" (where a total is known) plus "Load more", instead of numbered page buttons.
  - Rewriting all list APIs to offset paging would be a large regression risk. Revisit only if numbered pages are a hard requirement.
- **D2 Contacts vs companies.**
  - They stay separate models.
  - The All tab interleaves both lists, each in its own scope, ordered by last update.
  - The Individuals tab keeps the full contacts list with saved views, sheet, kanban, calendar and chart.
- **D3 Delete.** Contact delete stays a soft archive (restorable). Hard delete already exists under privacy erasure.
- **D4 Follow-ups.** There is no new activity kind. Follow-ups are open calls with the "follow-up required" outcome, plus open activities whose title names a follow-up, which is what the follow-up automations create.
- **D5 "Scheduled"** is a display label for an open meeting in the future. No new status value.
- **D6 Ticket replies** are stored on the ticket. Sending one reuses the messaging services. If the send is refused (no mailbox, no consent, WhatsApp window closed), nothing is saved and the error is shown.
- **D7 Merge** moves the source ticket's messages into the target, adds a note to both, and closes the source. Attachments stay on the source.
- **D8 Recent AI Actions** come from the member's saved assistant conversations. The assistant answers but does not act on its own, so a separate `ai_actions` table would have nothing to record. Record changes the assistant leads to go through the normal forms, which are audited.

## Risks and remaining items

- **Sample data.** The numbers in the screens are not reproduced. Every value is read from the tenant's data and filtered by permission, so a role without `deals.view` sees "No access" where the screenshot shows numbers.
- **Visual parity.** Checked against the screenshots through tests and a production build only. The browser was not connected, so a side-by-side visual pass is still to do.
- **Pagination.** Numbered pages and the "10 per page" selector are not built (D1).
- **Bulk export.** There is no export button on the contacts bulk bar; export lives in Settings → Import & Export.
- **SLA.** Overdue is computed from creation time and the current SLA. Pausing the clock while waiting on the customer is not modelled.
- **Voice input.** Needs browser support (Chrome, Edge, Safari). Firefox shows no mic button.

## Migrations added

| App | Migration | Change |
|---|---|---|
| helpdesk | `0003_category_product_messages` | Ticket `category`, `product`; new `TicketMessage` with RLS |
| deals | `0010_deal_priority_lead_source` | Deal `priority` (default medium), `lead_source` (blank) |
| tagging | `0003_favorite` | New `Favorite` with RLS |
| automation | `0004_stage_trigger_and_team` | (earlier pass, commit `d9cce50`) |

All four are additive. No column or table is dropped, and existing rows get safe defaults.
