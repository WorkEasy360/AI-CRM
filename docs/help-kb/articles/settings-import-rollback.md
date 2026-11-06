---
id: settings-import-rollback
title: How to Undo (Roll Back) an Import
question: How do I undo an import that went wrong?
module: Settings
keywords: [undo import, roll back import, rollback, revert import, delete imported records, wrong import, import undo kaise kare, galat import hatana, आयात वापस लें, रोलबैक]
route: /settings/data
menu_path: Settings → Security & Data → Import & Export Data
spotlight: Roll back
permission: contacts.import
related: [settings-import-data, settings-export-data]
updated: 2026-11-06
---

## Overview
Rolling back an import deletes the records it created and restores the records it updated to their earlier values. Use it when a file was mapped wrongly or imported twice.

## Before you start
- You need permission to import that record type (for contacts: Owner, Admin or Sales Manager).
- You can roll back only your own imports, once, after they have finished (status **Completed**, **Stopped at limit** or **Failed**).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Security & Data** card, click **Import & Export Data**.
3. In **Import from CSV or Excel**, set **Record type** to the type you imported, for example **Contacts**.
4. In **Your recent imports**, find the file.
5. Click **Roll back** on its row.
6. Read the confirmation and click **Roll back**.

## Result
The status changes to **Rolling back**, then **Rolled back**. The row shows how many records were deleted, how many were restored and how many were left unchanged.

## Tips
- Records changed since the import, or that now have notes, files or links, are left as they are and listed so you can review them.
- You can also roll back from the import's progress view: click **View** on the row, then **Roll back**.

## Troubleshooting
- **No Roll back button?** The import is still running, was already rolled back, or was started by another member.
- **"This import was already rolled back."** Each import can be rolled back only once.
