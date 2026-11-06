---
id: settings-whatsapp-connect
title: How to Add the WhatsApp Integration
question: How do I connect WhatsApp to the CRM?
module: Settings
keywords: [whatsapp integration, connect whatsapp, whatsapp business, whatsapp cloud api, meta, phone number id, access token, whatsapp kaise connect kare, whatsapp jodna, व्हाट्सएप, व्हाट्सएप जोड़ें]
route: /settings/whatsapp
menu_path: Settings → Communication → WhatsApp Integration
spotlight: Connect WhatsApp
permission: whatsapp.manage
related: [settings-whatsapp-webhook, settings-whatsapp-add-template, settings-whatsapp-disconnect, settings-automation-whatsapp]
updated: 2026-11-06
---

## Overview
Connect one WhatsApp Business number to the workspace through the WhatsApp Business Cloud API. Everyone with WhatsApp permission then shares it, and conversations are kept on the customer's record.

## Before you start
- You need the Owner or Admin role (`whatsapp.manage`).
- Your plan must include WhatsApp integration (Express plan or higher).
- In Meta Business Manager you need a WhatsApp Business number set up for the Cloud API and a permanent system-user access token.

## Steps
1. In Meta Business Manager, open **WhatsApp → API setup** and copy the phone number ID, the WhatsApp Business account ID and your permanent system-user token.
2. In the CRM, click **Settings** in the left sidebar.
3. In the **Communication** card, click **WhatsApp Integration**.
4. In the **Business account** card, paste the number into **Phone number ID**.
5. Optionally paste the **Business account ID (optional)**.
6. Paste the token into **Access token**.
7. Click **Connect WhatsApp**.
8. If **Confirm it's you** appears, enter your **Password** and click **Confirm** (or click **Confirm with Workeasy360**).
9. Set up the webhook so replies reach the CRM (see the WhatsApp webhook article).

## Result
You see "WhatsApp connected". The card shows a **Connected** badge with the **Display name**, **Phone number**, **Phone number ID** and **Connected** date. The token is stored encrypted and never shown again.

## Tips
- On the Integrations page, **Manage** on the **WhatsApp Business** card also opens this page.

## Troubleshooting
- **"WhatsApp rejected the credentials"?** Meta did not accept the token or phone number ID. Copy them again from API setup.
- **"Meta phone number IDs contain digits only."** Paste the ID, not the phone number.
- **"...is not included in your plan"?** Upgrade in Billing & Subscription.
- **"Ask an administrator to connect the Business account."** Your role cannot connect WhatsApp.
