---
id: settings-integrations-inbound-webhook
title: How to Enable an Inbound Webhook for an Integration
question: How can an external system push changes into the CRM?
module: Settings
keywords: [inbound webhook, receive webhook, push data, webhook url, signing secret, rotate secret, upsert, inbound webhook kaise banaye, data bhejna crm me, इनबाउंड वेबहुक]
route: /settings/integrations
menu_path: Settings → Integrations & API → Integrations (Connected Apps)
permission: integrations.manage
related: [settings-integrations-data-sharing, settings-integrations-connect-rest-api, settings-webhooks-create]
updated: 2026-11-06
---

## Overview
An inbound webhook lets the external system push contact, company and deal changes to WorkEasyCRM the moment they happen, instead of waiting for the next sync. Every request must be signed.

## Before you start
- You need the Owner or Admin role (`integrations.manage`).
- The connection must be connected, and its data sharing set to **External → CRM** or **Two-way** for the record types it sends.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **Integrations (Connected Apps)**.
3. Under **Connected**, click **Manage** on the connection's card.
4. Click the **Inbound webhook** tab.
5. Click **Enable inbound webhook**.
6. If **Confirm it's you** appears, confirm your identity.
7. In the dialog, click **Copy** next to the **Webhook URL** and next to the **Signing secret**, and give both to the sending system's developer.
8. Click **I have saved it**.

## Result
The card shows an **Enabled** badge. The URL and secret are shown only once.

## Tips
- Supported event types are `contact.upsert`, `company.upsert` and `deal.upsert`. Only fields you mapped are applied.
- If the secret was lost or exposed, click **Rotate secret**; the old secret keeps working for 24 hours.
- If the URL was lost, click **Create new URL**, then **Create new URL** to confirm. The old URL stops working immediately.

## Troubleshooting
- **Enable button greyed out?** Reconnect the integration first.
- **Requests rejected?** Check the signature and that the timestamp is within 5 minutes of the current time.
