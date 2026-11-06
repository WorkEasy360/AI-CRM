---
id: settings-ai-usage-limits
title: How to Check AI Usage and Limits
question: How much AI has my team used?
module: Settings
keywords: [ai usage, usage and limits, tokens, ai cost, requests per hour, daily token limit, knowledge search, ai kitna use hua, ai limit kya hai, एआई उपयोग, सीमा]
route: /settings/ai
menu_path: Settings → AI Assistant → Usage & Limits
permission: ai.settings.manage
related: [settings-ai-policy, assistant-chat]
updated: 2026-11-06
---

## Overview
Usage & Limits shows how much the AI assistant is used, the estimated cost, and the limits that apply to your workspace.

## Before you start
- You need the Owner or Admin role (`ai.settings.manage`).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **AI Assistant** card, click **Usage & Limits**.
3. Read the summary tiles: **Requests**, **Tokens**, **Estimated cost** and **Tokens today**.
4. Check **By feature** to see which assistants your team uses most.
5. Check **By member** to see requests and cost per person.
6. Check **Models and limits** for the models in use, **Requests per member per hour** and **Tokens per workspace per day**.

## Result
You see usage since the date shown above the tiles. The **Tokens today** bar shows the share of the daily workspace limit already used.

## Tips
- Models and limits are configured by your administrator in the server settings; they cannot be changed on this page. The only spending control here is the **Monthly budget** in the **AI policy** card.
- The **Knowledge search** card shows how many notes, emails, WhatsApp messages and meeting write-ups Ask WorkEasy can search, and how many are waiting to be indexed.
- Estimated cost is approximate, based on list prices.

## Troubleshooting
- **"Could not load AI usage"?** Click **Retry**.
- **"record(s) could not be indexed"?** The message in the **Knowledge search** card shows the last indexing error. Share it with your administrator.
