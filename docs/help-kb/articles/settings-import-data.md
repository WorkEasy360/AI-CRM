---
id: settings-import-data
title: How to Import Contacts from Excel or CSV
question: How do I import contacts from an Excel or CSV file?
module: Settings
keywords: [import contacts, import excel, import csv, upload contacts, xlsx, map columns, duplicates, bulk upload, contacts import kaise kare, excel se contact dalna, आयात, संपर्क आयात करें]
route: /settings/data
menu_path: Settings → Security & Data → Import & Export Data
spotlight: Choose file
permission: contacts.import
related: [settings-import-rollback, settings-export-data, settings-custom-fields-create, contacts-add-contact]
updated: 2026-11-06
---

## Overview
Bring contacts, companies, deals or products in from a spreadsheet: upload, match columns to fields, check, then import.

## Before you start
- Owner, Admin and Sales Manager can import contacts, companies and deals; products need Owner or Admin.
- Use .csv (UTF-8) or .xlsx, up to 5 MB, 10,000 rows and 60 columns, with headers in the first row. Old .xls files are not accepted. Only the first worksheet is read.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Security & Data** card, click **Import & Export Data**.
3. In **Import from CSV or Excel**, set **Record type** to **Contacts**.
4. Click **Choose file** and pick your file, or drop it on the box.
5. Click **Upload and map columns**.
6. In **Map columns**, choose a field under **Import into** for each **File column**, or **Skip this column**.
7. Under **Duplicates**, choose **Create new**, **Skip duplicates** or **Update duplicates**.
8. Keep **Create companies that don't exist yet** on to add missing companies.
9. Click **Check file**.
10. Review **Rows checked**, **Will create**, **Will update**, **Will skip**, **Will fail** and any **First problems**.
11. Click **Import**.

## Result
The import runs in the background with **Created**, **Updated**, **Skipped** and **Errors** counts, and is listed under **Your recent imports**. Failed rows are skipped and reported by row number.

## Tips
- Contacts are matched as duplicates by email, then phone.
- From another CRM? Pick **Zoho CRM export**, **HubSpot export** or **Pipedrive export** in **Mapping preset**.
- From the Contacts page, **Add Contact** → **Import** opens this page. A finished import can be rolled back.

## Troubleshooting
- **"Choose a .csv or .xlsx file."** Save the sheet as .xlsx or CSV UTF-8.
- **"Each field can receive only one column."** Skip one of the two columns.
- **"Stopped at limit"?** Your plan's record limit was reached.
