---
id: settings-whatsapp-webhook
title: How to Set Up the WhatsApp Webhook
question: Why are WhatsApp replies not showing in the CRM?
module: Settings
keywords: [whatsapp webhook, callback url, verify token, whatsapp replies, delivery status, meta webhook, messages field, whatsapp reply nahi aa raha, webhook kaise lagaye, व्हाट्सएप वेबहुक]
route: /settings/whatsapp
menu_path: Settings → Communication → WhatsApp Integration
spotlight: Copy webhook URL
permission: whatsapp.view
related: [settings-whatsapp-connect, settings-whatsapp-add-template]
updated: 2026-11-06
---

## Overview
Meta delivers incoming WhatsApp messages and delivery receipts to the CRM through a webhook. Without it, customer replies do not appear and sent messages stay "Sent".

## Before you start
- WhatsApp must be connected (see the WhatsApp integration article).
- You need admin access to the app in Meta Business Manager.
- Your administrator must have set the verify token in the server configuration. The **Webhook** card shows **Configured** when the server side is ready.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Communication** card, click **WhatsApp Integration**.
3. In the **Webhook** card, click the copy button (**Copy webhook URL**) next to the address.
4. In Meta Business Manager, open **WhatsApp → Configuration → Webhooks**.
5. Paste the callback URL you copied.
6. Enter the verify token your administrator set in the server configuration.
7. Subscribe to the `messages` field.

## Result
Meta verifies the URL. Customer replies and delivery status (delivered, read) now appear on the contact's WhatsApp conversation in the CRM.

## Tips
- The webhook URL ends with `/api/v1/whatsapp/webhook/`.

## Troubleshooting
- **Badge says Not configured?** The server is missing the WhatsApp app secret or verify token. Ask your administrator to add them.
- **Messages stay "Sent" and replies do not appear?** The webhook is not verified yet, or the `messages` field is not subscribed in Meta.
- **"Copy failed"?** Select the URL and copy it manually.
