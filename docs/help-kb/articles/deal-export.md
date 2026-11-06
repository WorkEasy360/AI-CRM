---
id: deal-export
title: How to Export Deals to CSV
question: How do I export my deals to Excel or CSV?
module: Pipeline
keywords: [export deals, download deals, csv, excel, deal report, backup, export products, deals download kaise kare, excel mein nikale, निर्यात, डाउनलोड]
route: /settings/data
menu_path: Settings → Security & Data → Import & Export Data
spotlight: Request export
permission: deals.export
related: [pipeline-list-view, pipeline-filter-deals, products-add]
updated: 2026-11-06
---

## Overview
Deals are exported to a CSV file from the Import & Export page. The file includes every deal you can see, with custom fields and tags. There is no export button on the Pipeline page itself.

## Before you start
- You need `deals.export`. Owner, Admin and Sales Manager have it.
- You will be asked to confirm your password.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Security & Data** card, click **Import & Export Data**.
3. In the **Export to CSV** card, choose **Deals** in **Record type**.
4. Click **Request export**.
5. Confirm your password when asked.
6. When the job is ready in **Export jobs**, click **Download**.

## Result
A CSV file with all deals in your scope. Files are kept for 24 hours.

## Tips
- List filters are not applied: the export contains all deals you can see.
- Choose **Products** in **Record type** to export your product catalogue (needs `products.export`, Owner or Admin).
- **Export everything** gives one ZIP file with a CSV per module.
