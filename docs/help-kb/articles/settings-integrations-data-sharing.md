---
id: settings-integrations-data-sharing
title: How to Choose What Data an Integration Can Share
question: How do I choose which data syncs with an integration?
module: Settings
keywords: [data sharing, field mapping, sync direction, two-way sync, sync frequency, conflict strategy, integration fields, data share kaise kare, field map karna, डेटा साझा, सिंक]
route: /settings/integrations
menu_path: Settings → Integrations & API → Integrations (Connected Apps)
permission: integrations.manage
related: [settings-integrations-manage-connection, settings-integrations-conflicts, settings-integrations-inbound-webhook]
updated: 2026-11-06
---

## Overview
For each connection you decide which CRM records it may read or change, in which direction, and which fields line up with the external system. Only the fields you map are exchanged.

## Before you start
- You need the Owner or Admin role (`integrations.manage`).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **Integrations (Connected Apps)**.
3. Under **Connected**, click **Manage** on the connection's card.
4. Click the **Data sharing** tab.
5. On the **Contacts**, **Companies** or **Deals** card, choose a direction: **Not shared**, **CRM → External**, **External → CRM** or **Two-way**.
6. Type the external **API path**, for example `/contacts`.
7. Under **Field mapping**, choose a **CRM field** and type the matching **External field**.
8. Click **Add field** for each further field.
9. Click **Save contacts** (or **Save companies** / **Save deals**).
10. On the **Overview** tab, in **Sync settings**, choose **Sync frequency** and **When both systems changed a record**, then click **Save settings**.

## Result
The card shows the direction and the number of mapped fields. The next sync exchanges only those fields.

## Tips
- Sync frequency options: **Manual only**, **Every 15 minutes**, **Hourly**, **Every 6 hours** and **Daily**.
- Conflict options: **CRM wins**, **External wins**, **Newest update wins** and **Manual resolution**.
- Notes, Email, WhatsApp and Attachments are marked **Never shared** and cannot be shared.

## Troubleshooting
- **"No fields can be exchanged in this direction."** Choose another direction for that record type.
