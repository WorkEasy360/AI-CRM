---
id: settings-integrations-connect-rest-api
title: How to Connect an External System with the Generic REST API
question: How do I connect another app through its REST API?
module: Settings
keywords: [rest api, generic rest api, connect integration, api connection, oauth 2.0, bearer token, base url, new connection, api se connect kaise kare, dusra software jodna, एपीआई कनेक्शन]
route: /settings/integrations
menu_path: Settings → Integrations & API → Integrations (Connected Apps)
spotlight: Connect
permission: integrations.manage
related: [settings-integrations-data-sharing, settings-integrations-manage-connection, settings-integrations-inbound-webhook, settings-integrations-overview]
updated: 2026-11-06
---

## Overview
The **Generic REST API** integration links WorkEasyCRM with any system that has a JSON REST API. After connecting, you choose which data it can see or change.

## Before you start
- You need the Owner or Admin role (`integrations.manage`).
- Get the external system's base URL and credentials (API key, bearer token or OAuth 2.0 client details).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Integrations & API** card, click **Integrations (Connected Apps)**.
3. On the **Generic REST API** card, click **Connect**.
4. Type a **Name**, for example "Marketing platform".
5. Choose **Authentication**: **API key**, **Bearer token**, **OAuth 2.0 authorization code**, **OAuth 2.0 client credentials** or **Signed webhook only**.
6. Type the **Base URL**, for example `https://api.example.com/v1`.
7. Fill in the credentials: **API key**, **Bearer token**, or for OAuth the **Client ID**, **Client secret**, **Authorization URL**, **Token URL** and **Scopes**.
8. For OAuth, click **Copy redirect URI** and register that URI in the external system.
9. Click **Create connection**.
10. If **Confirm it's you** appears, enter your **Password** and click **Confirm**.
11. For **OAuth 2.0 authorization code**, click **Connect with OAuth** and sign in to the external system (or click **Later**).

## Result
"Connection created" appears and the connection's detail page opens. Credentials are stored encrypted and never shown again.

## Tips
- **Signed webhook only** creates a receive-only connection: enable its inbound webhook afterwards.
- Open **Advanced** only if the API does not follow common conventions (health check path, API key header, record ID field, list key).

## Troubleshooting
- **Name error?** Each connection needs a unique name.
- **"Could not start sign-in"?** The authorization URL must be a valid https address.
