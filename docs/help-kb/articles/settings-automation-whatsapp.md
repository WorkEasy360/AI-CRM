---
id: settings-automation-whatsapp
title: How to Send WhatsApp Messages Automatically
question: How do I send an automatic WhatsApp message to new leads?
module: Settings
keywords: [whatsapp automation, auto whatsapp, welcome message, automatic follow-up, whatsapp template rule, lead welcome, auto whatsapp kaise bheje, naye lead ko message, स्वचालित व्हाट्सएप, ऑटो मैसेज]
route: /settings/automation
menu_path: Settings → Automation
spotlight: Create Automation
permission: automation.manage
related: [settings-automation-create, settings-whatsapp-add-template, settings-whatsapp-connect]
updated: 2026-11-06
---

## Overview
An automation can send an approved WhatsApp template to the contact, for example a welcome message when a new lead is added, or a reminder when a deal gets no reply.

## Before you start
- You need the Owner or Admin role (`automation.manage`).
- WhatsApp must be connected and at least one approved template added in WhatsApp Integration.

## Steps
1. Click **Settings** in the left sidebar.
2. Under **Also in Settings:**, click **Automation**.
3. Click **Create Automation**.
4. Type a **Name**, for example "New lead welcome".
5. Under **When**, choose a trigger, for example **A new contact (lead) is added**.
6. Under **Then**, choose **Send a WhatsApp template to the contact**.
7. In **WhatsApp template**, choose an approved template.
8. Fill in each **Value for {{1}}**, **Value for {{2}}** and so on. You can use merge fields such as `{{first_name}}`, `{{company}}` or `{{owner_name}}`.
9. Optionally set **Wait before acting (days)** and tick **Only if the contact has not replied**.
10. Click **Create**.

## Result
"Automation created" appears. The rule shows the template name and, once triggered, how many times it ran and how many steps are waiting.

## Tips
- The message is sent from the record owner, and only to contacts who have agreed to WhatsApp messages.
- The ready-made **New Lead Welcome (WhatsApp)** and **Proposal Follow-up** rules open this editor so you can pick the template.

## Troubleshooting
- **"No approved WhatsApp templates yet."** Connect WhatsApp and add a template in Settings → WhatsApp.
- **"Fill in every template value."** Every numbered value needs text or a merge field.
- **"Last run skipped" under the rule?** The reason is shown, for example "The contact has no phone number." or "The owner may not send WhatsApp messages."
