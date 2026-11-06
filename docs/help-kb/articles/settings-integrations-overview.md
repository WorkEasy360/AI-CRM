---
id: settings-integrations-overview
title: How to Use the Integrations (Connected Apps) Page
question: Which apps can I connect to the CRM?
module: Settings
keywords: [integrations, connected apps, connect app, third party, google workspace, microsoft 365, whatsapp business, rest api, integration kaise kare, app jodna, इंटीग्रेशन, ऐप जोड़ें]
route: /settings/integrations
menu_path: Settings → Integrations & API → Integrations (Connected Apps)
permission: integrations.view
related: [settings-integrations-connect-rest-api, settings-api-keys, settings-webhooks-create, settings-whatsapp-connect]
updated: 2026-11-06
---

## Overview
The Integrations page lists what is already connected to WorkEasy CRM and what you can connect, and lets you decide exactly which data each system can see or change.

## Before you start
- You need the Owner or Admin role (`integrations.view`; changing integrations needs `integrations.manage`).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **Integrations (Connected Apps)**.
3. Under **Connected**, review the apps and connections in use, with their status and **Last sync**.
4. Under **Available**, find the card for what you want to connect.
5. On **Google Workspace** or **Microsoft 365**, click **Manage** to open Email Settings.
6. On **WhatsApp Business**, click **Manage** to open WhatsApp Integration.
7. On **Generic REST API**, click **Connect** to link any system with a JSON REST API.
8. On **Webhooks**, click **Configure**. On **API keys**, click **Manage keys**.

## Result
You reach the setup page for the chosen integration. Connected REST API connections appear as cards under **Connected**; click **Manage** on a card to open its detail page.

## Tips
- Email mailboxes are personal: each member connects their own on Email Settings.
- Notes, email content, WhatsApp conversations and attachments are never shared with integrations.

## Troubleshooting
- **"Nothing connected yet"?** Connect an integration from the **Available** section.
- **"Not configured for this workspace yet."** An administrator must add the provider's OAuth settings on the server.
- **"No access"?** Ask an Owner or Admin.
