---
id: settings-api-keys
title: How to Generate or Revoke an API Key
question: How do I create an API key?
module: Settings
keywords: [api key, generate api key, create api key, revoke api key, api access, developer, bearer token, api key kaise banaye, api key hatana, एपीआई की, एपीआई कुंजी]
route: /settings/integrations/api-keys
menu_path: Settings → Integrations & API → API Keys
spotlight: Create API key
permission: integrations.manage
related: [settings-webhooks-create, settings-integrations-overview]
updated: 2026-11-06
---

## Overview
API keys let external software use the WorkEasy CRM API with only the permissions you grant. A key can never do more than the member who created it.

## Before you start
- You need the Owner or Admin role (`integrations.manage`).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **API Keys**.
3. Click **Create API key**.
4. Type a **Name** after the system that will use it, for example "Accounting sync".
5. Under **Permissions**, tick only what it needs, for example **Read contacts** or **Create and update deals**.
6. Choose **Expires**: **After 30 days**, **After 90 days**, **After 180 days**, **After 365 days** or **Never expires**.
7. Click **Create key**.
8. If **Confirm it's you** appears, enter your **Password** and click **Confirm**.
9. Click **Copy** next to the **API key** and store it in a secret manager.
10. Click **I have saved it**.

## Result
"API key created" appears. The key is listed with its permissions, status, creator, expiry and **Last used** date. Only the start of the key is shown from now on.

## Tips
- To revoke a key, click **Revoke** on its row, then **Revoke key**. Systems using it lose access immediately; this cannot be undone.
- Send the key in the header `Authorization: Bearer YOUR_API_KEY`. Keys work only on the contacts, companies, deals and activities endpoints under `/api/v1/`.
- Create one key per external system so you can revoke one without affecting the others.

## Troubleshooting
- **Lost the key?** It cannot be shown again. Revoke it and create a new one.
- **"Choose at least one permission."** Tick at least one box.
