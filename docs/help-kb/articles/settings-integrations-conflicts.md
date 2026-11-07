---
id: settings-integrations-conflicts
title: How to Resolve Integration Sync Conflicts
question: How do I fix a sync conflict with an integration?
module: Settings
keywords: [sync conflict, resolve conflict, keep crm, apply external, integration conflict, changed in both systems, conflict kaise solve kare, sync problem, टकराव, सिंक समस्या]
route: /settings/integrations
menu_path: Settings → Integrations & API → Integrations (Connected Apps)
permission: integrations.manage
related: [settings-integrations-data-sharing, settings-integrations-manage-connection]
updated: 2026-11-06
---

## Overview
When a record changes in both WorkEasyCRM and the external system, it waits on the **Conflicts** tab for your decision. You choose which values to keep.

## Before you start
- You need the Owner or Admin role (`integrations.manage`) to resolve conflicts.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **Integrations (Connected Apps)**.
3. Under **Connected**, click **Manage** on the connection's card.
4. Click the **Conflicts** tab. The number of open conflicts shows in brackets.
5. For each row, compare the **Record** and the **Different fields (external value)**.
6. Click **Keep CRM** to keep the CRM values, or **Apply external** to take the external values.

## Result
The conflict leaves the list. The other system is updated on the next sync. When none are left you see "No open conflicts".

## Tips
- To have conflicts settled automatically, open the **Overview** tab and change **When both systems changed a record** in **Sync settings** to **CRM wins**, **External wins** or **Newest update wins**.
- The **Overview** tab also shows **Open conflicts** with a **Review** link to this tab.

## Troubleshooting
- **No Keep CRM or Apply external buttons?** Your role can view the connection but not change it.
