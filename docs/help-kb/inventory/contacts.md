## Contacts

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Add individual (Add Contact panel) | /contacts | Contacts → People (Contacts) → Add Contact → Individual | contacts.create | Full Name*, Phone* (+ Country code), Company Name (Optional), Email, Job Title / Designation, Tags, Notes | Save Contact, Cancel, Create company inline | contacts-add-contact |
| New contact form (long form) | /contacts?tab=people | Individuals tab → Contact | contacts.create | First name / Last name / Email (one required*), Phone, Company, Status, More details: Job title, Source, Owner (all-scope only), Description, WhatsApp consent, address, custom fields | Create contact | contacts-add-contact |
| Add company (Add Contact panel) | /companies | Contacts → Companies → Add Contact → Company | companies.create | Company Name*, Phone, Website, Tags, Notes | Save Company | companies-add-company |
| New company form (long form) | /companies | Companies toolbar → Company | companies.create | Name*, Website, Phone, Industry, Status, More details: Company size, Source, Annual revenue, Revenue currency, Owner, Description, address, custom fields | Create company | companies-add-company |
| Tabs: All Contacts / Individuals / Companies / Favorites / Tags | /contacts | Contacts → People (Contacts) | contacts.view (Companies tab needs companies.view) | Type filter (All Types, Individuals, Companies) | View, Add to favorites | contacts-list-tabs |
| KPI cards | /contacts | Contacts → People (Contacts) | contacts.view | Total Contacts, Individuals, Companies, Favorites, Tagged | Click-through on Individuals, Companies, Favorites | contacts-kpi-cards |
| Link contact to company | /contacts | Contact page → Edit → Company | contacts.update | Company | Save changes; Company page Contacts tab → New contact | contacts-link-company |
| Tags on a record | /contacts | Contact or company page → Tags section | contacts.update / companies.update (new tags: tags.manage) | Tag list | Add tags, Edit (toggle) | contacts-tags |
| Favourites | /contacts | All Contacts row ⋮ | tags.view | — | Add to favorites, Remove from favorites | contacts-favorites |
| Edit contact | /contacts | Contact page → Edit | contacts.update | as New contact form | Save changes, Reload on conflict | contacts-edit-contact |
| Edit company | /companies | Company page → Edit | companies.update | as New company form | Save changes | companies-edit-company |
| Archive / restore contact | /contacts?tab=people | Contact page → More actions → Archive / Restore; Individuals row ⋮ | contacts.delete | — | Archive, Restore, Archived contacts view | contacts-archive-restore |
| Archive / restore company | /companies | Companies row ⋮ or company page → More actions | companies.delete | — | Archive, Restore, Archived companies view | companies-archive-restore |
| Bulk archive / restore | /contacts?tab=people | Individuals (List) → select rows | contacts.bulk_update / companies.bulk_update | — | Archive, Restore (with confirm) | contacts-bulk-archive |
| Bulk add / remove tag | /contacts?tab=people | Individuals (List) → select rows | contacts.bulk_update | Tag | Add tag, Remove tag | contacts-bulk-tags |
| Bulk reassign | /contacts?tab=people | Individuals (List) → select rows → Reassign | contacts.bulk_update + contacts.update (all scope) | New owner* | Reassign | contacts-bulk-reassign |
| Filters and sort | /contacts?tab=people | Individuals → view menu, Filters, sort menu | contacts.view | View (All/My/Archived contacts), Status, Company (Any/Has/No company); Companies: Status, Industry, Company size | Clear | contacts-filter-sort |
| Search | /contacts | All Contacts search box | contacts.view | Search text | — | contacts-search |
| Saved views | /contacts?tab=people | Individuals → Saved views | org.view (sharing: views.share) | Name*, Who can use it (Only me / Everyone / Selected teams), Open with this view by default | Save as new view…, Save changes, set/stop default, Delete view | contacts-saved-views |
| View modes and columns | /contacts?tab=people | Individuals → List / Kanban / Sheet / Calendar / Chart | contacts.view | Group by, Place by, Measure, Columns | Drag cards, sheet edits with Save N rows / Discard | contacts-view-modes |
| Status (lifecycle stage) | /contacts | Contact page → status badge | contacts.update | Lead, Prospect, Qualified, Customer, Inactive | Change status | contacts-lifecycle-status |
| Owner change (single) | /contacts | Contact page → Edit → More details → Owner | contacts.update (all scope) | Owner | Save changes | contacts-change-owner |
| Lead score | /contacts | Contact page → score chip | ai.scores.view | — | Show reasons (Rules-based score) | contacts-lead-score |
| Duplicate warning | /contacts | Add Contact panel; New/Edit contact and company forms | contacts.view (duplicates endpoint) | email, phone, first+last name; company name, website | Open | contacts-duplicate-warning |
| Notes | /contacts | Contact or company page → Notes tab; quick action Note | notes.create (edit/delete: notes.update / notes.delete) | Note text* | Add note, Pin note, Edit note, Delete note | contacts-notes |
| Files | /contacts | Contact page → Files tab | files.upload (view: files.view, delete: files.delete) | File* (max 10 MB, PDF/image/text/Office) | Choose a file, drag and drop, download, delete | contacts-files |
| Tickets tab | /contacts | Contact page → Tickets tab | tickets.view (create: tickets.create) | — | Open ticket in Helpdesk, Create Ticket | contacts-tickets-tab |
| WhatsApp from contact | /contacts | Contact page → WhatsApp quick action / WhatsApp tab | whatsapp.send (tab: whatsapp.view) | Message (24h window) or Template + values; consent needed for templates | Send, Send template, Draft with AI, quick reply | contacts-send-whatsapp |
| Email from contact | /contacts | Contact page → Email quick action / Emails tab | email.send (tab: email.view) | To*, Cc/Bcc, Subject, Template, Message, Attach files | Send, New email, reply | contacts-send-email |

### Not in product
- Permanent delete of a contact or company: the UI and API only archive (soft delete) and restore.
- Export from the Contacts or Companies list: no export button on these pages (exports live in Settings → Import & Export Data).
- Import inside the contacts list: the Add Contact → Import item only links to Settings → Import & Export Data (/settings/data).
- Favourite toggle on the contact or company detail page and on the Companies list row menu: favourites are set only from the All Contacts / Favorites / Tags list (and the Individuals row menu).
- Saved views, view modes (Kanban/Sheet/Calendar/Chart) and column picker on the Companies page: only on the Individuals tab.
- Bulk actions on the All Contacts tab: only on Individuals (List view) and Companies.
- Files tab and Tickets tab on company pages: contact pages only.
- Email quick action on company pages: only the Emails tab (New email).
- Merge duplicates: duplicates are only flagged, never merged.
