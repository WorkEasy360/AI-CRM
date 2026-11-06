---
id: settings-automation-create
title: How to Create an Automation Rule
question: How do I create an automation?
module: Settings
keywords: [automation, create automation, workflow, rule, trigger, follow-up task, notify owner, automatic task, automation kaise banaye, apne aap task, स्वचालन, ऑटोमेशन]
route: /settings/automation
menu_path: Settings → Automation
spotlight: Create Automation
permission: automation.manage
related: [settings-automation-whatsapp, settings-automation-manage, activities-create-task]
updated: 2026-11-06
---

## Overview
Automation rules run by themselves when something happens in the CRM, for example creating a follow-up task when a new lead is added. Rules act as the record's owner and never do more than the owner may do.

## Before you start
- You need the Owner or Admin role (`automation.manage`). Sales Managers can view rules but not change them.

## Steps
1. Click **Settings** in the left sidebar.
2. Under **Also in Settings:**, click **Automation**.
3. Click **Create Automation**.
4. Type a **Name**.
5. Under **When**, choose the trigger: **A new contact (lead) is added**, **A new deal is created**, **A deal enters a stage**, **A deal is won** or **A deal is lost**.
6. If you chose **A deal enters a stage**, pick the **Stage**.
7. Under **Then**, choose **Create a follow-up task for the owner**, **Notify the owner**, **Notify the owner's team** or **Send a WhatsApp template to the contact**.
8. Type the **Task title** or **Notification text** (it defaults to the rule name).
9. Set the days in **Due after (days)** or **Wait before acting (days)**, from 0 to 90.
10. Optionally tick **Only if the contact has not replied**.
11. Click **Create**.

## Result
"Automation created" appears and the rule is listed, switched on, with "Has not run yet".

## Tips
- When you have no rules yet, click a ready-made rule to start: **New Lead Welcome (WhatsApp)**, **Follow-up Reminder**, **Proposal Follow-up** or **Deal Won Notification**.
- With **Only if the contact has not replied**, the step is skipped if the contact writes back on WhatsApp or by email during the wait.

## Troubleshooting
- **"Choose the stage the deal has to enter."** Pick a **Stage** for stage rules.
- **No Create Automation button?** Your role can only view automations.
