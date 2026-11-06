---
id: settings-custom-fields-edit-archive
title: How to Edit, Archive or Restore a Custom Field
question: How do I edit or remove a custom field?
module: Settings
keywords: [edit custom field, archive field, restore field, delete custom field, rename field, change options, show archived, field edit kaise kare, field hatana, फ़ील्ड बदलें, फ़ील्ड हटाएं]
route: /settings/custom-fields
menu_path: Settings → CRM Configuration → Custom Fields
permission: customfields.manage
related: [settings-custom-fields-create, settings-import-data]
updated: 2026-11-06
---

## Overview
You can rename a custom field, change its options, help text or required setting, and archive a field you no longer need. Archiving hides the field but keeps the values already stored on records.

## Before you start
- You need the Owner or Admin role (`customfields.manage`).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Custom Fields**.
3. Click the record type tab, for example **Contacts**.
4. Click the **⋯** button at the end of the field's row (labelled **Actions for** and the field name).
5. To change the field, click **Edit**, update the **Label**, **Options**, **Help text** or **Required**, then click **Save changes**.
6. To hide the field, click **Archive**, then click **Archive field** to confirm.
7. To bring an archived field back, turn on **Show archived**, click the **⋯** button on the field, then click **Restore**.

## Result
You see "Field updated", "Field archived" or "Field restored". An archived field disappears from forms, tables and filters, and shows an **Archived** badge when **Show archived** is on.

## Tips
- The **Key** and **Type** are fixed once a field exists; only the label, options, help text and required setting can change.
- There is no permanent delete. Archive the field instead; you can restore it later with its stored values.
- Fields are listed by position. There is no option to reorder them on this page.

## Troubleshooting
- **No ⋯ button?** Your role cannot manage custom fields. Ask an Owner or Admin.
- **Archived field not listed?** Turn on **Show archived**.
