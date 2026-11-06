---
id: helpdesk-sla-overdue
title: How to Set the SLA and Find Overdue Tickets
question: How do I change the SLA hours for tickets?
module: Helpdesk
keywords: [sla, resolution time, overdue tickets, ticket deadline, sla settings, due time, sla kaise set kare, late ticket, समय सीमा, अतिदेय टिकट]
route: /helpdesk
menu_path: Helpdesk → SLA settings
spotlight: SLA settings
permission: org.update
related: [helpdesk-priority-category, helpdesk-filter-search, helpdesk-resolve-close]
updated: 2026-11-06
---

## Overview
The resolution SLA sets how many hours a ticket of each priority may stay open before it counts as overdue. Defaults: **Urgent** 4 hours, **High** 8, **Medium** 24 and **Low** 72.

## Before you start
- Anyone with `tickets.view` can see the SLA. Only Owner and Admin (the `org.update` permission) can change it.

## Steps
1. Click **Helpdesk** in the left sidebar.
2. Click the **SLA settings** button next to the filters.
3. In **Resolution SLA**, enter the hours for **Urgent**, **High**, **Medium** and **Low** (1 to 2160).
4. Click **Save**.
5. To see late tickets, click the **Overdue** tab (or the **Overdue** tile).

## Result
"SLA updated" appears. The new hours apply at once to all open and in-progress tickets. Overdue tickets show a red **Overdue** label, and the ticket panel shows the **Due (SLA)** time.

## Tips
- The SLA clock starts when the ticket is created.
- Resolve or close a ticket to stop it from becoming overdue.
- The **Avg. Resolution** tile shows the average time to resolve over the last 30 days.

## Troubleshooting
- **Fields are greyed out with "Only workspace administrators can change the SLA."** Ask an Owner or Admin.
