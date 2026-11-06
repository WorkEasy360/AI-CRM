---
id: helpdesk-merge-delete
title: How to Merge or Delete a Ticket
question: How do I merge duplicate tickets?
module: Helpdesk
keywords: [merge ticket, duplicate ticket, delete ticket, combine tickets, remove ticket, ticket merge kaise kare, ticket delete karna, विलय, हटाएं]
route: /helpdesk
menu_path: Helpdesk → Ticket Details → More
permission: tickets.update
related: [helpdesk-resolve-close, helpdesk-filter-search, helpdesk-create-ticket]
updated: 2026-11-06
---

## Overview
Merge a duplicate ticket into the main one so the whole conversation is in one place. Delete a ticket only when it was created by mistake.

## Before you start
- Merging needs `tickets.update`. Deleting needs `tickets.delete`, which Owner, Admin and Sales Manager have. Sales Representative and Viewer cannot delete tickets.

## Steps
1. Click **Helpdesk** in the left sidebar.
2. Click the duplicate ticket's ID or subject to open **Ticket Details**.
3. Click **More**.
4. Click **Merge into another ticket**.
5. In **Merge into ticket**, type the other ticket's number, for example #TK-1044.
6. Click **Merge**.
7. To delete a ticket instead, click **More**, then **Delete**.
8. Confirm with **Delete ticket**.

## Result
After a merge, the conversation moves to the other ticket, the duplicate is closed, and the main ticket opens. After a delete, the ticket and its conversation are removed for everyone.

## Tips
- Prefer merging or closing over deleting, so the history is kept.
- Deleting cannot be undone.

## Troubleshooting
- **"No other ticket has that number."** Check the number in the **Ticket ID** column and try again.
