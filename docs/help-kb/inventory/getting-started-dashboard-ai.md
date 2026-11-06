## Getting Started

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Sidebar and top bar navigation | (all app pages) | Left sidebar; top bar | — | — | Dashboard, Pipeline, Contacts (People (Contacts), Companies), Activities, AI Assistant, Helpdesk, Products, Settings; Collapse/Expand Contacts; logo → Dashboard; WhatsApp inbox button (whatsapp.view); Open navigation (small screens) | getting-started-navigation |
| Global search (Ctrl K / ⌘ K) | (all app pages) | Top bar → Search | search.use | Query* (min 2, max 200 chars) | Search, ↑/↓ move, Enter open, Esc close; groups Contacts, Companies, Deals, Activities, Tickets, Products | getting-started-global-search |
| Create menu | (all app pages) | Top bar → Create | per item: contacts.create, companies.create, deals.create, activities.create, tickets.create | (form per record type) | Contact, Company, Deal, Task, Call, Meeting, Ticket (ticket → /helpdesk?new=1) | getting-started-create-menu |
| Notifications | (all app pages) | Top bar → bell | notifications.view | — | Open notification (marks read), Mark all read, Preferences (→ /settings/notifications) | getting-started-notifications |
| Help menu (?) | (all app pages) | Top bar → Help | — | — | Search everything, Ask WorkEasy AI, Settings | getting-started-help-menu |
| Account menu / profile | /settings/security | Top bar → Account menu → Profile & security | — | — | Shows name, email, organization · role; Profile & security; Settings | getting-started-profile |
| Theme | (all app pages) | Account menu → Theme | — | Light / Dark / System | Switch theme (stored in browser) | getting-started-theme |
| Switch organization | (all app pages) | Account menu → Organization | — | — | Pick organization (only with >1 active membership); lands on /pipeline | getting-started-switch-workspace |
| Sign out | (all app pages) | Account menu → Sign out | — | — | Sign out; or Sign out of WorkEasy CRM / Sign out of WorkEasy CRM and Workeasy360 (Workeasy360 sessions) | getting-started-sign-out |
| Mobile bottom bar | (all app pages, < lg) | Bottom bar | search.use for Search; create perms for New | — | Pipeline, Contacts, Activities, Search, New (Task, Call, Contact, Deal) | getting-started-mobile-navigation |
| Sign in (password) | /login | Sign in | — | Email*, Password* | Sign in, Forgot password?, Create account, Use another sign-in method | getting-started-login |
| Sign in 2FA step | /login | Sign in → Two-factor authentication | — | Authentication code* (TOTP or recovery code) | Verify, Use a different account | getting-started-login-two-factor |
| Workeasy360 sign-in | /login | Sign in → Already a Workeasy360 user? | — | — | Access WorkEasy CRM | getting-started-workeasy360-sign-in |
| Sign up | /signup | Sign in → Create account | — | Name*, Email*, Password* (min 12) | Create account → Check your email | getting-started-sign-up |
| Verify email | /verify-email/[key] | Email link | — | — | Open your CRM / Sign in; Go to sign in on failure | getting-started-verify-email |
| Forgot / reset password | /forgot-password, /reset-password/[key] | Sign in → Forgot password? | — | Email*; New password* (min 12), Confirm new password* | Send reset link, Update password, Sign in | getting-started-forgot-password |
| Accept invitation | /invitations/accept?token= | Email link | — | New user: Name*, Password*, Confirm password* (email fixed) | Create account and join; Accept invitation (signed in); Sign in with a different account; Sign in to accept | getting-started-accept-invitation |

### Not in product
- Editing your own name, photo or profile details (Account menu "Profile & security" opens /settings/security: Password, Two-factor authentication, Active sessions only).
- A dedicated "Switch workspace" screen. Switching is the Account menu "Organization" radio list (shown only with more than one active membership) or Settings → Organization Details → "Your organizations" card → Open (that card also has "New organization"; Settings slice owns it).
- Help centre / documentation link in the "?" menu (it has only Search everything, Ask WorkEasy AI, Settings).

## Dashboard

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Dashboard widgets | /dashboard | Dashboard | dashboards.view (widget data scoped by each record permission) | — | KPI tiles Total Contacts, Companies, Total Deals, Expected Revenue, Win Rate; Sales Pipeline Overview; Revenue Trend; Key Business Summary; Deals by Source; Top Performing Team; Recent Activities | dashboard-overview |
| Period / pipeline / trend range | /dashboard?period=&pipeline=&months= | Dashboard → Period | dashboards.view | Period (last 12 months, Last 7 days, Last 30 days, Last 90 days, Last 12 months); Pipeline (if >1); Revenue trend range (Last 3/6/12 Months) | Filter, URL-shareable | dashboard-filter-period |
| Quick Actions | /dashboard | Dashboard → Quick Actions | per tile: contacts.create, deals.create, activities.create, whatsapp.view, email.view, automation.view, deals.view | — | Add Contact, Add Deal, Add Task, Schedule Meeting, Send WhatsApp, Send Email, Create Automation, View Reports | dashboard-quick-actions |
| WorkEasy AI Insights | /dashboard | Dashboard → WorkEasy AI Insights | dashboards.view | — | Follow-ups due today, deals close to winning (≥60%, ≤30 days), win rate change, deals without next step, tickets past SLA; Ask WorkEasy AI → /assistant | dashboard-ai-insights |
| Today's Agenda / Upcoming & Overdue | /dashboard | Dashboard → right column | activities.view | — | View all; Overdue Activities, Activities Due This Week, Deals Closing This Week | dashboard-today-panel |
| More insights | /dashboard | Dashboard → More insights | dashboards.view | — | Pipeline value, Weighted pipeline, Won revenue, Deals won, Deals lost, Tasks due, Meetings, Calls, Lead conversion, Average deal size; Sales Funnel, Deal Stage, Forecast (Details), Deals by owner, Top companies | dashboard-more-insights |
| Forecast | /dashboard/forecast (also Pipeline → Forecast tab) | Dashboard → Forecast | reports.view | Period (This month, This quarter, Custom From/To); Pipeline; Group by (Stage, Salesperson, Team, Pipeline) | Tiles Pipeline value, Weighted, Committed (≥75%), Won so far, Expected revenue; By month chart; breakdown table; Review close dates | dashboard-forecast |

### Not in product
- Customising the dashboard (add/remove/rearrange widgets, saved or shared dashboards). Permissions dashboards.manage_own / dashboards.manage_shared exist in the catalogue but no UI uses them.
- Exporting or printing the dashboard.

## AI Assistant

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Ask a question (chat) | /assistant | AI Assistant | ai.assistant.use (generative analysis also needs ai.copilot.use; API throttle 20/min) | Question* (max 1000 chars) | Ask, suggestion chips (Write a follow-up message, Show deal forecast, Create a task, Team performance), follow-up suggestions | assistant-chat |
| Answer layout | /assistant | AI Assistant → answer | ai.assistant.use | — | From your CRM, Analysis, Suggested next step, sections, Sources (links), notice | assistant-understanding-answers |
| AI Quick Actions | /assistant | AI Assistant → AI Quick Actions | ai.assistant.use; Create Automation needs automation.view; Get Reports needs deals.view | — | Write Message (WhatsApp / Email), Create Automation, Create Task, Schedule Meeting, Generate Proposal, Summarize Lead, Get Reports, More Tools (Create follow-up sequence, Suggest next action, Create WhatsApp campaign, Analyze pipeline, Automation ideas) | assistant-quick-actions |
| Voice input | /assistant | AI Assistant → mic | ai.assistant.use | — | Speak your question / Stop voice input (browser speech recognition only) | assistant-voice-input |
| Recent conversations / new question | /assistant | AI Assistant → Recent AI Actions; Ask WorkEasy panel → New question | ai.assistant.use | — | View All / Show less (titles only, max 5); New question deletes current thread | assistant-recent-conversations |
| Mode badge | /assistant | AI Assistant header | ai.assistant.use; ai.copilot.use + AI enabled → Powered by AI | — | Powered by AI / Knowledge search mode | assistant-knowledge-search-mode |
| Floating button and panel | (all app pages) | Ask WorkEasy AI (bottom right); sidebar WorkEasy AI → Ask AI Now; Help → Ask WorkEasy AI | ai.assistant.use | Question* | Ask WorkEasy panel, Ask, New question | assistant-open-anywhere |
| Weekly summary and follow-ups | /assistant | AI Assistant → This week | ai.assistant.use; dashboards.view for figures; activities.view for follow-ups | — | New Leads, Deals, Revenue, Pending Follow-ups; Your Follow-up Tasks (Today) checkbox complete; AI Suggestion View/View Leads; AI Insights & Recommendations | assistant-weekly-summary |

### Not in product
- Reopening a past conversation from "Recent AI Actions" (list is titles only, not clickable).
- The assistant creating, updating or sending records/messages itself (drafts only; record creation goes through the normal forms).
- Voice input in the side panel (mic only on the /assistant page).
- Uploading files or images to the assistant.
