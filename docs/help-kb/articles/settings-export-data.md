---
id: settings-export-data
title: How to Export Your Data to CSV
question: How do I export my contacts or deals to a file?
module: Settings
keywords: [export, export contacts, export deals, download data, csv export, backup data, export everything, zip, data export kaise kare, contacts download karna, निर्यात, डेटा डाउनलोड]
route: /settings/data
menu_path: Settings → Security & Data → Import & Export Data
spotlight: Request export
permission: contacts.export
related: [settings-import-data, settings-import-rollback]
updated: 2026-11-06
---

## Overview
Export contacts, companies, deals or products to a CSV file, or everything at once as a ZIP with one CSV per module. Exports include every record you can see, with custom fields and tags.

## Before you start
- Owner, Admin and Sales Manager can export contacts, companies and deals. Products can be exported by Owner and Admin.
- You will be asked to confirm your password.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Security & Data** card, click **Import & Export Data**.
3. In **Export to CSV**, choose a **Record type**: **Contacts**, **Companies**, **Deals**, **Products** or **Everything (.zip)**.
4. Click **Request export**, or click **Export everything** for all modules.
5. In **Confirm it's you**, enter your **Password** and click **Confirm** (or click **Confirm with Workeasy360**).
6. Wait until the job in **Export jobs** shows **Completed**.
7. Click **Download** (or **Download .zip** for a full export).

## Result
The file downloads to your computer. The **Export jobs** list shows when it was requested, the number of rows, the size and when it expires.

## Tips
- Files are kept for 24 hours, then show "No longer available". Request a new export if needed.
- List filters are not applied: an export contains all records of that type in your scope.
- Cells that look like spreadsheet formulas are neutralised so the file is safe to open in Excel.

## Troubleshooting
- **"Could not request export"?** Your role may not include export for that record type.
- **Status Failed?** The error is shown under the status. Request the export again.
