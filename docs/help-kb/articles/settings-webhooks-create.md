---
id: settings-webhooks-create
title: How to Create a Webhook
question: How do I set up a webhook to notify another system?
module: Settings
keywords: [webhook, create webhook, add webhook, outbound webhook, endpoint url, signing secret, events, webhook kaise banaye, dusre system ko notify karna, वेबहुक, वेबहुक बनाएं]
route: /settings/integrations/webhooks
menu_path: Settings → Integrations & API → Webhooks
spotlight: Add webhook
permission: webhooks.manage
related: [settings-webhooks-manage, settings-api-keys, settings-integrations-inbound-webhook]
updated: 2026-11-06
---

## Overview
A webhook makes WorkEasyCRM send a signed HTTPS request to your endpoint the moment selected events happen, such as a new contact or a deal changing stage.

## Before you start
- You need the Owner or Admin role (`webhooks.manage`).
- You need a public `https://` endpoint that can receive and verify the requests.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **Webhooks**.
3. Click **Add webhook**.
4. Type a **Name**, for example "Data warehouse".
5. Type the **Endpoint URL** (must start with `https://`).
6. Under **Events**, tick the events to send: **Contact created**, **Contact updated**, **Company created**, **Company updated**, **Deal created**, **Deal updated**, **Deal stage changed** or **Task completed**.
7. Turn on **Include record fields** only if the receiver needs the standard fields in the event itself.
8. Click **Create webhook**.
9. If **Confirm it's you** appears, enter your **Password** and click **Confirm**.
10. Click **Copy** next to the **Signing secret** and add it to the receiving system.
11. Click **I have saved it**.

## Result
"Webhook created" appears and the webhook is listed with its events, **Status**, **Last success** and **Last failure**.

## Tips
- With **Include record fields** off, events carry only the record type and ID; the receiver fetches details with an API key.
- The receiver should verify every request with the signing secret, as described in the signature headers shown in the dialog, and ignore repeated event IDs.
- Send a test from the **⋯** menu with **Send test event**.

## Troubleshooting
- **"Use a public https:// address."** Private network addresses and plain http are not allowed.
- **Lost the secret?** Use **Rotate secret** to get a new one.
