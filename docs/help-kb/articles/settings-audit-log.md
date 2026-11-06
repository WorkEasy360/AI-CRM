---
id: settings-audit-log
title: How to Use the Audit Log
question: How do I see who changed what in the workspace?
module: Settings
keywords: [audit log, activity log, who changed, security log, history, login history, track changes, kisne badla, audit log kaise dekhe, ऑडिट लॉग, गतिविधि लॉग]
route: /settings/audit-log
menu_path: Settings → Security & Data → Activity / Audit Log
spotlight: Filter
permission: audit.view
related: [settings-roles-permissions, faq-data-security, settings-change-role]
updated: 2026-11-06
---

## Overview
The audit log lists every security-relevant change in the organization, newest first: sign-ins, role changes, invitations, team changes, integration changes and more.

## Before you start
- Only the Owner and Admins can view the audit log.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Security & Data** card, click **Activity / Audit Log**.
3. Optionally fill in one or more filters: **Action**, **Actor user ID**, **Resource type**, **Since** and **Until**.
4. Click **Filter**.
5. Click **Details** under an action to see what exactly changed.

## Result
The table shows **When**, **Action**, **Actor**, **Resource**, **IP** and **Request** for each matching event. Click **Load more** to see older events.

## Tips
- **Action** must match the full action name, for example `members.role_changed`, `members.invited` or `teams.created`.
- The **Actor** badge shows who made the change: a user, the AI assistant, an integration or the system.
- Click the **X** (**Clear filters**) button to show everything again.

## Troubleshooting
- **"No access".** Your role does not include permission to view the audit log.
- **"Nothing matches these filters."** Check the spelling of the action name and the date range.
