---
id: settings-email-connect-mailbox
title: How to Connect Your Email Mailbox (Gmail or Microsoft 365)
question: How do I connect my Gmail or Outlook mailbox?
module: Settings
keywords: [connect email, gmail, microsoft 365, outlook, mailbox, email settings, email integration, oauth, email kaise connect kare, gmail jodna, ईमेल जोड़ें, मेलबॉक्स]
route: /settings/email
menu_path: Settings → Communication → Email Settings
permission: email.connect
related: [settings-email-reconnect-disconnect, settings-email-templates, settings-integrations-overview]
updated: 2026-11-06
---

## Overview
Connect your own mailbox to send email from CRM records. Replies to messages sent from the CRM are logged on the record automatically. Each member connects their own mailbox.

## Before you start
- You need the Owner, Admin, Sales Manager or Sales Representative role (`email.connect`). Viewers cannot connect a mailbox.
- Your administrator must have set up the Google or Microsoft sign-in (OAuth) for the workspace.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Communication** card, click **Email Settings**.
3. In the **Connected mailbox** card, under **Connect a mailbox**, click **Connect Gmail** or **Connect Microsoft 365**.
4. Sign in to your Google or Microsoft account on the provider's page.
5. Allow the requested access.

## Result
You return to the Email page with the message "Mailbox connected". Your address appears in the list with a **Connected** badge, the provider name and the last sync time.

## Tips
- The CRM never sees your password: sign-in happens with the provider (OAuth).
- On the Integrations page, the **Google Workspace** and **Microsoft 365** cards link to this same page with **Manage**.

## Troubleshooting
- **Button is greyed out with "Not configured for this workspace"?** An administrator must set the OAuth credentials on the server.
- **"Mailbox not connected"?** The provider did not finish the sign-in. Try again, or ask an administrator to check the OAuth settings.
- **"Your role cannot connect a mailbox."** Ask an administrator to change your role.
