# WorkEasy360 CRM: gap report against the reference screens

Audit date: 2026-11-05, baseline commit `d9cce50` (branch `release/bigin-m1-m2`).
Reference screens: Dashboard, Pipeline, Contacts, Activities, AI Assistant, Helpdesk, Settings.

Legend: ✅ exists and matches · 🟡 exists, needs update · ❌ missing · ⏭ deliberately not built (see "Decisions").
The **Final** column is filled in as each module lands.

## Stack found

- Backend: Django + DRF modular monolith (`backend/apps/*`), PostgreSQL with RLS and fail-closed tenant managers, Celery + Redis (beat for reminders, automation sweeps).
- Frontend: Next.js 15 App Router, React Query, Tailwind v4 with `--kl-*` design tokens, Radix primitives (`components/ui/*`), vitest.
- Auth/authz: session auth, `authz.scope`/`check` role grants (own/team/all), reauth for sensitive changes, audit log (`apps.audit`).
- AI: Anthropic provider router (`apps/ai/providers`), deterministic intent → scoped SQL tools → model as evidence (`apps/assistant`), quotas (`apps/ai/budgets.py`).

## Reusable pieces found

`PageHeader`, `KpiTile`/`percentChange` (dashboard/stat-tile), `DataTable` + `BulkBar` + `use-cursor-list`, `ListToolbar`, `ViewBar` (saved views: list/kanban/sheet/calendar/chart), `Sheet` (slide-over), `Tabs`, `QuickActions` (record call/email/WhatsApp/meeting), `TagPicker`, `DuplicateWarning`, `formatMoney`, `notifications.notify`, `messaging.send_whatsapp`/email, `audit.record`, `storage` (private blobs).

## Main tables/models found

Organization, Membership, Role, Team · Contact, Company, Deal, DealStageHistory, DealProduct, Pipeline, PipelineStage, Product, PriceBook · Activity (task/call/meeting) · Note, File, Tag · EmailMessage, WhatsAppMessage, templates · Ticket · AutomationRule/Run · Notification · Conversation/ConversationTurn, AIUsage · ApiCredential, WebhookSubscription, OutboundDelivery · AuditEvent · SavedView, CustomField.

---

## Phase 1: global layout

| Feature / UI element | Status | Current files | Work required | Final |
|---|---|---|---|---|
| Dark green sidebar, green active pill, logo + CRM pill | ✅ | shell/nav.tsx, styles/tokens.css | — | ✅ |
| Nav order Dashboard…Settings | 🟡 | shell/nav.tsx `PRIMARY_NAV` | Extra "Products" item and People/Companies sub-items; keep them (existing features) but after the spec items | |
| "WorkEasy AI" promo card + Ask AI Now → | ❌ | shell/nav.tsx | Build card at sidebar bottom, links to /assistant | |
| Global search incl. tickets | 🟡 | shell/global-search.tsx, apps/search/service.py | Add ticket target (scoped by `tickets.view`), new placeholder | |
| + Create: Contact, Company, Deal, Task, Call, Meeting, Ticket | 🟡 | shell/quick-add.tsx | Add Ticket | |
| WhatsApp top-bar button | ❌ | shell/app-shell.tsx | Button → Activities WhatsApp tab (inbox) | |
| Bell with red dot + dropdown | 🟡 | shell/notifications-menu.tsx | Has count badge + dropdown + mark read/all; switch to red dot | |
| Help (?) and avatar menu | ✅ | app-shell.tsx, user-menu.tsx | — | ✅ |
| Page header with large icon | 🟡 | components/page-header.tsx | Add optional `icon` prop | |
| KPI tile with trend | ✅ | dashboard/stat-tile.tsx | Reuse on every page | ✅ |
| Tabs with counts | 🟡 | ui/tabs.tsx | Count rendered in labels where a count exists | |
| Data table with checkboxes + ⋮ | 🟡 | crm/data-table.tsx | Per-page ⋮ menus already exist; add where missing | |
| Numbered pagination "Showing 1–8 of N", 10 per page | 🟡 | crm/data-table.tsx, lib/use-cursor-list.ts | App-wide cursor "Load more" (see Decisions D1) | |
| Right slide-over panel | ✅ | ui/sheet.tsx | Reuse for detail panels | ✅ |
| INR lakh formatting, Asia/Kolkata, +91 | 🟡 | lib/crm/format.ts `formatMoney` | Uses browser locale; force `en-IN` grouping for INR + compact "L"/"Cr" helper for chart axes | |

## 1. Dashboard

| Feature / UI element | Status | Current files | Work required | Final |
|---|---|---|---|---|
| Greeting "Good Afternoon, Manoj! 👋" + subtitle | 🟡 | dashboard/dashboard-page.tsx | Wording/casing | |
| Month selector filtering dashboard | 🟡 | dashboard-page.tsx, apps/dashboards/service.py | Add `month=YYYY-MM` period (keep presets) | |
| KPIs: Total Contacts, Companies, Total Deals, Expected Revenue, Win Rate + trend | 🟡 | service.py | Add contact/company totals with previous-period comparison, expected revenue (weighted open) | |
| Sales Pipeline Overview tiles, clickable | 🟡 | dashboard/charts.tsx `SalesFunnel` | Coloured stage tiles linking to pipeline filtered by stage | |
| Revenue Trend bar+line, 3/6/12 months, total, growth | 🟡 | charts.tsx `RevenueTrend`, service.py `TREND_MONTHS` | `months` param, bars + line, total + growth % | |
| Today's Agenda timeline | ❌ | — | Today's activities for the user | |
| Upcoming & Overdue (overdue, due this week, deals closing this week) | 🟡 | dashboard-page.tsx | Panel with three linked rows; add deals closing this week | |
| Key Business Summary incl. Open Tickets + trends | 🟡 | dashboard-page.tsx | Activity totals by kind with previous period, open tickets | |
| Deals by Source donut | ❌ | — | Needs `Deal.source` (Pipeline module) + aggregate | |
| Top Performing Team (avatar, deals + bar, revenue) | 🟡 | charts.tsx `DealsByOwner` | Won deals/revenue per owner as table | |
| Recent Activities + View All | ❌ | — | Latest activities list | |
| Quick Actions ×8 | ❌ | — | Grid reusing quick-create, WhatsApp/email, automation, reports | |
| WorkEasy AI Insights (computed) | ❌ | — | 4 insights from real counts + Ask WorkEasy AI | |

## 2. Pipeline – Leads & Deals

| Feature / UI element | Status | Current files | Work required | Final |
|---|---|---|---|---|
| Title + subtitle | 🟡 | crm/pipeline/pipeline-page.tsx | Fixed title, spec subtitle, pipeline name moves to selector | |
| KPIs incl. Avg. Deal Cycle + trends | ❌ | apps/deals/api.py | Pipeline stats endpoint (deals, value, expected, win rate, cycle days vs previous) | |
| Tabs Kanban / List / Forecast / Analytics | 🟡 | views/view-bar.tsx, forecast/forecast-page.tsx | Forecast is a separate route; Analytics missing → tab bar + analytics endpoint (stage conversion, win/loss, source, owner) | |
| Filters: owners, sources, products | 🟡 | pipeline-page.tsx, apps/deals/api.py FILTERS | Owner picker, `source`, `product` filters | |
| Deal priority / source fields | ❌ | apps/deals/models.py | Additive migration: `priority`, `source` | |
| Kanban card: priority badge, owner name | 🟡 | crm/pipeline/kanban-board.tsx | Add priority badge + owner name; Won check icon | |
| Per-column + Add Deal in that stage | ❌ | kanban-board.tsx, deal-form-dialog.tsx | `stage` prefill | |
| Drag & drop + history | ✅ | kanban-board.tsx, move_stage API | — | ✅ |
| Dashed drag hint bar | ❌ | — | Add | |
| Deal Details slide-over (stage select, editable fields, Activities/Notes/Files, actions, Move to Next Stage) | ❌ | deal-detail-page.tsx (full page exists) | Sheet panel on card click reusing existing deal APIs; full page stays | |

## 3. Contacts

| Feature / UI element | Status | Current files | Work required | Final |
|---|---|---|---|---|
| Subtitle + KPIs (Total, Individuals, Companies, Favorites, Tagged) | ❌ | crm/contacts/contacts-page.tsx, apps/contacts/api.py `stats` | Extend stats; favourites model | |
| Favorites | ❌ | — | Per-member favourite (additive model) + toggle API + filter | |
| Tabs All / Individuals / Companies / Favorites / Tags | 🟡 | crm/contacts-tabs.tsx | Tabs with counts; Companies tab links to companies list (D2) | |
| + Add Contact dropdown (Individual / Company / Import) | 🟡 | contacts-page.tsx | Dropdown | |
| Tag filter | ❌ | apps/contacts/api.py | `tag` filter | |
| Table: initials avatar, Type pill, WhatsApp icon on phone, Tags, Last activity | 🟡 | contacts-page.tsx | Columns | |
| Row ⋮: View, Edit, Favorite, Add Tag, Delete | 🟡 | contacts-page.tsx | Add Favorite; Delete = existing archive (D3) | |
| Bulk tag/assign/delete, export | 🟡 | crm/bulk-bar.tsx | Export from bar (reuse importexport) | |
| Add Contact slide-over: Individual/Company toggle, Full Name*, company search + inline create, +91 phone*, job title, tags, notes, duplicates | 🟡 | contact-form-dialog.tsx, duplicates.py | Rebuild as Sheet panel reusing existing create APIs | |
| Contact detail: tickets | 🟡 | contact-detail-page.tsx | Tickets tab (ticket `contact` filter exists) | |

## 4. Activities

| Feature / UI element | Status | Current files | Work required | Final |
|---|---|---|---|---|
| Subtitle | ❌ | activities/activities-page.tsx | Add | |
| KPIs Total / Tasks / Calls / Meetings + trends | 🟡 | apps/activities/api.py `summary` | Per-kind counts current vs previous period | |
| Tabs All / Tasks / Calls / Meetings / Follow-ups | 🟡 | activities-page.tsx | Add Follow-ups (calls with `follow_up_required` outcome or open follow-up tasks; D4) | |
| Filters: type, status, owner, This week / Today / This month / Custom; list/calendar toggle | 🟡 | activity-list.tsx | Backend already filters kind/status/owner/from/to; add UI | |
| Table with Related To, Owner avatar, red due, status, ⋮ incl. Reschedule | 🟡 | activity-list.tsx, activity-item.tsx | Grouped list today; table layout + Reschedule | |
| Right column: Today's Schedule, mini calendar, Upcoming, Overdue | ❌ | my-day.tsx, calendar.tsx | Build side column | |
| Form + reminders via notifications | ✅ | activity-form-dialog.tsx, activities/tasks.py | — | ✅ |
| "Scheduled" status | 🟡 | apps/activities/models.py | Shown for future open meetings (display only, D5) | |

## 5. AI Assistant

| Feature / UI element | Status | Current files | Work required | Final |
|---|---|---|---|---|
| Header, subtitle, "Powered by AI" badge | 🟡 | assistant/assistant-page.tsx | Wording + badge | |
| Inline chat with green user bubbles + avatars | 🟡 | assistant/ask-keel.tsx (sheet) | Inline conversation on page | |
| Rich cards: summary (New Leads/Deals/Revenue/Pending Follow-ups) + today's follow-ups with actions | 🟡 | answer-view.tsx, crm_tools.py | Today card rendered from real data | |
| AI Suggestion banner + View Leads | ❌ | — | From computed insights | |
| Suggestion chips (4 spec chips) | 🟡 | orchestrator.py `suggestions_for` | Spec chips, still permission-filtered | |
| Mic voice input | ❌ | ask-keel.tsx | Web Speech API where supported | |
| Real data, scoped, persisted history | ✅ | apps/assistant/* | — | ✅ |
| AI Quick Actions ×8 (spec set) | 🟡 | assistant-page.tsx | Spec tiles; Create Task / Schedule Meeting / Create Automation open the real forms | |
| AI Insights & Recommendations | ❌ | apps/ai/insights.py | List on page | |
| Recent AI Actions + View All | ❌ | AuditEvent / ConversationTurn | List from member's recent assistant turns | |
| Usage limits | ✅ | apps/ai/budgets.py | — | ✅ |

## 6. Helpdesk

| Feature / UI element | Status | Current files | Work required | Final |
|---|---|---|---|---|
| Subtitle + KPIs (Total, Open, In Progress, Resolved, Overdue, Avg. Resolution + trend) | 🟡 | helpdesk/helpdesk-page.tsx, apps/helpdesk/services.py | Extend summary | |
| Tabs with counts | ❌ | helpdesk-page.tsx | Add | |
| Filters: priority, category, agent, product, search by ID | 🟡 | apps/helpdesk/api.py | `category`, `product` fields + filters; number search | |
| Ticket ID `#TK-XXXX` | 🟡 | helpdesk-page.tsx | Display format `#TK-1001` | |
| Category with icon, Company column, ⋮ menu, relative Updated | ❌ | models.py | Additive `category`, `product`; company via contact | |
| Ticket Details slide-over with inline editing | ❌ | `TicketDialog` (modal) | Sheet panel | |
| Conversation / Internal Notes / Activity tabs | ❌ | — | `TicketMessage` model (public reply / internal note), audit-backed activity endpoint | |
| Reply box (attachment, emoji, send) by email/WhatsApp | ❌ | — | Reply stored; optional send by email to contact (D6) | |
| Mark as Resolved, More ▾ (Reassign, Priority, Merge, Close, Delete) | 🟡 | api.py | Buttons; Merge (D7) | |
| SLA due from priority, overdue flag | ❌ | — | Per-priority SLA hours in org settings, `due_at`, overdue filter/count | |

## 7. Settings

| Feature / UI element | Status | Current files | Work required | Final |
|---|---|---|---|---|
| Landing page: 6 cards in 3×2 grid | ❌ | settings/settings-index.tsx (redirect) | Build grid; each item links to the existing page | |
| Organization, Users & Teams, Roles | ✅ | members-page.tsx, teams-page.tsx, roles-page.tsx | — | ✅ |
| Pipelines & Stages, Custom Fields, Tags | ✅ | pipelines-page.tsx, custom-fields-page.tsx, tags-page.tsx | — | ✅ |
| Email, WhatsApp, Message Templates, Notifications | ✅ | email-/whatsapp-settings-page.tsx, message-templates-page.tsx, notifications-settings-page.tsx | — | ✅ |
| AI Settings | ✅ | ai-settings-page.tsx | — | ✅ |
| Usage & Limits | 🟡 | ai-settings-page.tsx, billing-page.tsx | Link to the AI usage section | |
| Password & 2FA, Import & Export, Audit Log | ✅ | security-page.tsx, data-page.tsx, audit-log-page.tsx | — | ✅ |
| Integrations, API Keys (hashed), Webhooks (secret, deliveries, retries) | ✅ | integrations/*, apps/integrations | — | ✅ |

## Phase 3: cross-module

| Item | Status | Work required | Final |
|---|---|---|---|
| Contact ↔ Company ↔ Deal ↔ Activity links | ✅ | — | ✅ |
| Contact ↔ Ticket | 🟡 | Tickets tab on contact | |
| Create/update/stage change → audit + notifications + webhooks | ✅ | domain events, audit, webhooks exist; new models must emit audit | |

---

## Decisions

- **D1 Pagination.** Every list API uses cursor pagination, which stays correct and fast on large tenants. "Showing 1–N of total" plus "Load more" replaces numbered page buttons. Rewriting all list APIs to offset paging would be a large regression risk. Revisit only if numbered pages are a hard requirement.
- **D2 Contacts vs companies.** They stay separate models and lists. The Contacts tabs expose both, and a combined table would need a union endpoint that breaks saved views.
- **D3 Delete.** Contact delete stays a soft archive (restorable). Hard delete already exists under privacy erasure.
- **D4 Follow-ups.** No new activity kind. The tab lists open activities whose title, call outcome, or source automation marks them as a follow-up (call outcome `follow_up_required`, or tasks created by follow-up automations).
- **D5 "Scheduled"** is a display label for an open meeting in the future. No new status value.
- **D6 Ticket replies** are stored on the ticket. Sending a reply by email or WhatsApp reuses the messaging services, so consent, templates and plan checks still apply.
- **D7 Merge tickets** moves the messages into the target ticket and closes the source.

## Risks

- New migrations must stay additive: Deal `priority`/`source`, Ticket `category`/`product`/`due_at`/messages, contact favourites.
- Sample numbers in the screens are not reproduced. Every value is read from the tenant's data and permission-filtered, so a role without `deals.view` sees fewer tiles than the screenshot.
- Visual parity is checked against the screenshots by tests and build only. The browser was not connected during this work.

## Migrations added

(filled in per module)
