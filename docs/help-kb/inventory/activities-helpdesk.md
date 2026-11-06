## Activities

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Create task | /activities | Activities → New task (or More ways to add → Task) | activities.create | Title*, Due date, Time, Priority, Repeat; More details: Description, Contact, Company, Deal, Owner (all-scope only), Mark as done | Create task | activities-create-task |
| Schedule call | /activities?tab=calls | Activities → Calls → New call (or More ways to add → Schedule call) | activities.create | Title*, When*, Direction, Duration (minutes), Notes; More details: Contact, Company, Deal, Priority, Owner | Schedule call | activities-schedule-call |
| Log call | /activities | Activities → More ways to add → Log a call | activities.create | Title*, When*, Direction, Duration (minutes), Outcome, Notes; More details | Log call (saved Completed) | activities-log-call |
| Schedule meeting | /activities?tab=meetings | Activities → Meetings → New meeting (or More ways to add → Meeting) | activities.create | Title*, Starts*, Ends, All day, Repeat, Attendees, Location, Meeting link, Reminder; More details | Schedule meeting | activities-schedule-meeting |
| Meeting reminder | /activities?tab=meetings | Activities → Meetings → meeting form → Reminder | activities.create / activities.update | Reminder (No reminder, 10 minutes before, 30 minutes before, 1 hour before, 1 day before) | Set, change | activities-set-reminder |
| Mark complete / reopen | /activities | Activities → ⋮ → Mark complete / Reopen; checkbox in grouped list and My Day | activities.update | Call outcome dialog: Outcome, Note (optional) | Mark complete, Mark as done, Reopen | activities-mark-complete |
| Reschedule | /activities | Activities → ⋮ → Reschedule | activities.update | Due date/Time, When, Starts/Ends | Save changes | activities-reschedule |
| Edit / delete | /activities | Activities → ⋮ → Edit / Delete | activities.update / activities.delete | All form fields + Status (edit only) | Save changes, Delete | activities-edit-delete |
| Repeat (recurrence) | /activities | Activity form → Repeat | activities.create / activities.update | Repeat (Does not repeat, Daily, Weekly, Monthly, Yearly), Every, weekdays, Never ends / Ends after / Ends on | Set, stop series | activities-repeat |
| Subtasks | /activities?tab=tasks&layout=grouped | Activities → Tasks → Grouped list → ⋯ → Add subtask | activities.create + activities.update on parent | Add a subtask (title) | Add, tick, untick (max 50, tasks only, one level) | activities-subtasks |
| Calendar | /activities?tab=calendar | Activities → Calendar | activities.view | Month / Week / Day; My calendar / Everyone | Navigate, open event, create meeting on a day | activities-calendar-view |
| My Day / Today's Schedule | /activities?tab=day | Activities → My Day; Today's Schedule card | activities.view | Sections: Overdue, Tasks, Events, Calls, No date | Tick done, edit | activities-my-day |
| Overdue | /activities | Activities → Overdue card → View All | activities.view | Due filter: Overdue | Complete, reschedule | activities-overdue |
| Follow-ups | /activities?tab=followups | Activities → Follow-ups | activities.view | Filter tab (open + outcome Follow-up required or title contains "follow") | Filter, complete | activities-follow-ups |
| Table filters | /activities | Activities → All Activities | activities.view | Search activities…, All Types, All Status, All Owners, date range (Any time, Today, This Week, This Month, Custom From/To) | Filter, Load more, Grouped list, Calendar view | activities-filter-search |
| Bulk actions | /activities?layout=grouped | Activities → Grouped list → Select | activities.bulk_update (Reassign also needs activities.update all-scope) | Selection, New owner | Mark complete, Reassign | activities-bulk-actions |
| KPI row + side cards | /activities | Activities | activities.view | Total Activities, Tasks, Calls, Meetings; Today's Schedule, mini calendar, Upcoming, Overdue | View All | activities-kpi-summary |
| WhatsApp inbox (log) | /activities?tab=whatsapp | Activities → WhatsApp; top bar WhatsApp inbox | whatsapp.view | Columns: Activity, Related to, Date, Owner, Status | Show more, open contact | activities-whatsapp-inbox |
| Send / reply WhatsApp | /contacts | Contacts → People (Contacts) → contact → WhatsApp | whatsapp.send | Write a reply… (24 h window) or Template + Value for {{n}} | Send, Send template message, Templates and AI draft…, Draft with AI | activities-whatsapp-reply |
| Email log | /activities?tab=emails | Activities → Emails | email.view | Columns: Activity, Related to, Date, Owner, Status | Show more, open contact → Emails → Reply / New email | activities-email-log |

### Not in product
- "Other" activity kind: only Task, Call and Meeting exist.
- Follow-up as an activity kind: it is a filter tab only.
- Reminders on tasks and calls: the form offers Reminder for meetings only.
- Repeating calls: calls cannot repeat.
- Bulk actions from the table view or the Follow-ups tab: bulk selection exists only in the grouped list (All, Tasks, Calls, Meetings).
- Sending or replying to WhatsApp/email from the Activities WhatsApp/Emails tabs: those tabs are read-only logs; sending happens on the contact (or deal) page.
- Logging a past meeting from the Activities page: the "More ways to add" menu has Log a call only.

## Helpdesk

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Create ticket | /helpdesk | Helpdesk → Create Ticket (or top bar Create → Ticket) | tickets.create | Subject*, Category (default Support), Priority (default Medium), Requester (contact) or Or requester name, Description | Create Ticket | helpdesk-create-ticket |
| Ticket from contact | /contacts | Contacts → People (Contacts) → contact → Tickets → Create Ticket | tickets.create (tab needs tickets.view) | Same as create, requester prefilled | Create Ticket, open ticket | contacts-tickets-tab |
| Assign / reassign | /helpdesk | Helpdesk → ticket → More → Reassign | tickets.update (other members: all-scope) | Assign to | Reassign | helpdesk-assign-ticket |
| Priority / category | /helpdesk | Helpdesk → ticket → Category / Priority lists; More → Change priority | tickets.update | Category (Technical, Billing, Account, Support, Sales, Other); Priority (Low, Medium, High, Urgent) | Change inline | helpdesk-priority-category |
| Reply to customer | /helpdesk | Helpdesk → ticket → Conversation | tickets.update (+ email.send / whatsapp.send to send out) | Type your reply…, Send as (Reply (log only), Reply by email, Reply by WhatsApp, Log customer message) | Send, Attach a file, Insert emoji, Attachments | helpdesk-reply-customer |
| Internal notes | /helpdesk | Helpdesk → ticket → Internal Notes | tickets.update | Add an internal note… | Add note | helpdesk-internal-notes |
| Resolve / close / reopen | /helpdesk | Helpdesk → ticket → Mark as Resolved; More → Close / Reopen; list ⋮ / bulk bar → Mark as Resolved | tickets.update | Status: Open, In Progress (automatic on first reply), Resolved, Closed | Mark as Resolved, Close, Reopen | helpdesk-resolve-close |
| SLA + overdue | /helpdesk | Helpdesk → SLA settings; Overdue tab | view: tickets.view; edit: org.update | Hours per Urgent/High/Medium/Low (1–2160; defaults 4/8/24/72) | Save | helpdesk-sla-overdue |
| Search / filters / tabs | /helpdesk | Helpdesk | tickets.view | Tabs: All Tickets, Open, In Progress, Resolved, Overdue; Search tickets by ID, subject, customer…; All Priorities, All Categories, All Agents, All Products | Filter, Load more | helpdesk-filter-search |
| Merge / delete | /helpdesk | Helpdesk → ticket → More → Merge into another ticket / Delete | tickets.update / tickets.delete | Merge into ticket (#TK number) | Merge, Delete ticket | helpdesk-merge-delete |
| KPI tiles | /helpdesk | Helpdesk | tickets.view | Total Tickets, Open, In Progress, Resolved, Overdue, Avg. Resolution | Tiles link to tabs | helpdesk-filter-search, helpdesk-sla-overdue |
| Activity (audit) tab | /helpdesk | Helpdesk → ticket → Activity | tickets.view | — | View history | helpdesk-assign-ticket (mentioned) |

### Not in product
- Setting or changing a ticket's Product in the UI: Product is shown in Ticket Details only when already set (outside the UI) and can be used as a list filter, but neither the create dialog nor the panel lets you pick one.
- Manually setting status to In Progress: it is set automatically by the first reply on an Open ticket; there is no control for it.
- Choosing an assignee in the Create Ticket dialog: new tickets are assigned to the creator; reassign afterwards.
- Per-category SLA or business-hours SLA: SLA is hours per priority only.
