---
id: settings-integrations-manage-connection
title: How to Test, Sync, Pause or Disconnect an Integration
question: How do I test or disconnect a connected integration?
module: Settings
keywords: [manage integration, test connection, sync now, pause integration, disconnect integration, delete connection, update credentials, integration band kaise kare, sync kaise kare, इंटीग्रेशन हटाएं, सिंक]
route: /settings/integrations
menu_path: Settings → Integrations & API → Integrations (Connected Apps)
permission: integrations.manage
related: [settings-integrations-data-sharing, settings-integrations-conflicts, settings-integrations-connect-rest-api]
updated: 2026-11-06
---

## Overview
Each REST API connection has a detail page where you check its status and sync history, run a test or a sync, pause it, update its credentials, disconnect it or delete it.

## Before you start
- You need the Owner or Admin role (`integrations.manage`) to change a connection.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **Integrations (Connected Apps)**.
3. Under **Connected**, click **Manage** on the connection's card.
4. On the **Overview** tab, check **Status**, **Last sync**, **Last successful sync** and **Recent sync jobs**.
5. Click **Test connection** to check that the credentials work.
6. Click **Sync now** to start a sync straight away.
7. To pause, update credentials or disconnect, click the **⋯** button (**More connection actions**), then click **Pause**, **Update credentials** or **Disconnect**.
8. Confirm with **Disconnect** if asked.

## Result
You see "Connection works" or "Connection test failed", "Sync started", or "Disconnected". A disconnected connection stops syncing and its stored credentials are deleted; CRM data is kept.

## Tips
- A paused connection shows **Resume** in the same menu.
- After disconnecting, click **Reconnect** to enter credentials again, or choose **Delete connection** in the **⋯** menu to remove it with its sharing settings and sync history.
- Change how often it syncs in **Sync settings** on the **Overview** tab.

## Troubleshooting
- **Sync now is greyed out?** The connection is paused or already busy.
- **Status shows an error message?** Read **Last error**, then use **Update credentials** if the credentials expired.
