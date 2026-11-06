---
id: settings-require-2fa
title: How to Require Two-Factor Authentication for Everyone
question: How do I make two-factor authentication mandatory for my team?
module: Settings
keywords: [require 2fa, mandatory 2fa, enforce mfa, two-factor for all, security policy, authenticator required, 2fa sabke liye, 2fa compulsory kaise kare, दो-चरणीय सत्यापन, सुरक्षा]
route: /settings/general
menu_path: Settings → Workspace → Organization Details
spotlight: Require two-factor authentication
permission: org.update
related: [settings-enable-2fa, settings-organization-details, faq-data-security]
updated: 2026-11-06
---

## Overview
When this setting is on, every member must set up an authenticator app before they can use this organization. It protects the workspace even if someone's password leaks.

## Before you start
- Only the Owner and Admins can change it.
- Set up two-factor authentication on your own account first, so you are not blocked yourself.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Workspace** card, click **Organization Details**.
3. In the **General** card, turn on **Require two-factor authentication**.
4. Click **Save changes**.
5. If a **Confirm it's you** window appears, enter your password and click **Confirm**.

## Result
A message says **Organization updated**. Members without two-factor authentication see a banner saying the organization requires it, with a **Set it up now** link, and cannot use the CRM until they set it up.

## Tips
- The **MFA** column on **Users & Teams** shows who already has it **On**.
- Members who sign in with a Workeasy360 account meet this rule only through two-step verification in their Workeasy360 account; their banner asks them to turn it on there and sign in again.

## Troubleshooting
- **A member says they are blocked.** Ask them to open **Settings → Security & Data → Password & 2FA** and click **Set up authenticator app**.
