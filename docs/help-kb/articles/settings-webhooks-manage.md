---
id: settings-webhooks-manage
title: How to Test a Webhook and View Its Deliveries
question: How do I check if my webhook is delivering events?
module: Settings
keywords: [webhook deliveries, test webhook, send test event, pause webhook, rotate secret, delete webhook, webhook failed, webhook check kaise kare, webhook band karna, वेबहुक डिलीवरी]
route: /settings/integrations/webhooks
menu_path: Settings → Integrations & API → Webhooks
permission: webhooks.manage
related: [settings-webhooks-create, settings-api-keys]
updated: 2026-11-06
---

## Overview
From the Webhooks list you can send a test event, see the latest deliveries, pause or resume a webhook, rotate its signing secret, or delete it.

## Before you start
- You need the Owner or Admin role (`webhooks.manage`).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **Webhooks**.
3. Click the **⋯** button on the webhook's row (labelled **Actions for** and the webhook name).
4. Click **Send test event** to check the endpoint.
5. Open the menu again and click **View deliveries** to see the latest 50 events with **Event**, **Status**, **Attempts**, **Response** and **Time**.
6. Use **Pause** or **Resume** to stop or restart sending.
7. Use **Rotate secret** to get a new signing secret, then copy it and click **I have saved it**.
8. Use **Delete**, then **Delete** to confirm, to remove the webhook.

## Result
You see "Test event delivered" with the endpoint's HTTP answer, or "Test event failed" with the reason. Other actions show "Webhook paused", "Webhook resumed" or "Webhook deleted".

## Tips
- Temporary failures are retried automatically.
- After rotating, WorkEasy signs with both the new and the previous secret for 24 hours, so switch the receiver over within that time.
- **Send test event** is available only while the webhook is active.

## Troubleshooting
- **Last failure shows an error?** The text explains it, for example "Only https:// addresses are allowed." or "The receiving system did not respond in time."
- **Deleted by mistake?** Deleting cannot be undone; create the webhook again.
