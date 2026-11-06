---
id: settings-whatsapp-add-template
title: How to Add a WhatsApp Message Template
question: How do I add a WhatsApp template?
module: Settings
keywords: [whatsapp template, add template, approved template, meta template, template message, 24 hour window, remove template, whatsapp template kaise add kare, template jodna, व्हाट्सएप टेम्पलेट]
route: /settings/whatsapp
menu_path: Settings → Communication → WhatsApp Integration
spotlight: Add template
permission: whatsapp.manage
related: [settings-whatsapp-connect, settings-message-templates, settings-automation-whatsapp]
updated: 2026-11-06
---

## Overview
WhatsApp only allows approved templates outside the 24-hour reply window. Record each template Meta has approved here, so members and automations can send it. Approval itself happens in Meta.

## Before you start
- You need the Owner or Admin role (`whatsapp.manage`).
- The template must already be approved in Meta Business Manager.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Communication** card, click **WhatsApp Integration**.
3. In the **Message templates** card, click **Add template**.
4. Type the **Name** exactly as approved in Meta, for example `order_update` (lowercase letters, digits and underscores).
5. Type the **Language** code, for example `en` or `en_US`.
6. Choose a **Category**: **Marketing**, **Utility**, **Authentication** or **Not set**.
7. Paste the **Body**, keeping numbered placeholders such as `{{1}}` and `{{2}}`.
8. Click **Add template**.

## Result
You see "Template added". The template is listed with its **Language**, **Category**, number of **Placeholders**, **Status** and **Added** date.

## Tips
- Each numbered placeholder becomes an input when the template is sent.
- To remove a template, click its trash button (**Remove** and the template name), then click **Remove**. It stays approved in Meta and can be added again.
- The same section also appears on **Message Templates**.

## Troubleshooting
- **"A template with this name and language already exists."** It is already recorded.
- **"Use lowercase letters, digits and underscores..."** Copy the name exactly from Meta.
