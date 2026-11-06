---
id: settings-custom-fields-create
title: How to Create a Custom Field
question: How do I add a custom field to contacts or deals?
module: Settings
keywords: [custom field, new field, add field, fields and forms, dropdown field, extra field, field type, naya field kaise banaye, custom field add karna, कस्टम फ़ील्ड, फ़ील्ड]
route: /settings/custom-fields
menu_path: Settings → CRM Configuration → Custom Fields
spotlight: New field
permission: customfields.manage
related: [settings-custom-fields-edit-archive, settings-import-data, contacts-add-contact, deal-create]
updated: 2026-11-06
---

## Overview
Custom fields store your own information on Contacts, Companies, Deals and Products. A new field appears on the record form, in tables and in filters.

## Before you start
- You need the Owner or Admin role (`customfields.manage`). Other roles can see custom fields but cannot create or change them.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Custom Fields**.
3. Click the record type tab: **Contacts**, **Companies**, **Deals** or **Products**.
4. Click **New field**.
5. Type a **Label**, for example "Lead score". The **Key** fills in automatically.
6. Choose a **Type**, for example **Text**, **Number**, **Date**, **Dropdown** or **Multi-select**.
7. For **Dropdown** or **Multi-select**, type the **Options**, one per line.
8. Optionally type **Help text** (shown under the field on forms).
9. Turn on **Required** if people must fill it in when saving a record.
10. Click **Create field**.

## Result
A "Field created" message appears and the field is listed in the table for that record type, with its label, key, type and position.

## Tips
- The key and type cannot be changed after the field is created. Choose them carefully.
- Available types: Text, Long text, Whole number, Number, Currency, Percent, Date, Date & time, Checkbox, Dropdown, Multi-select, Email, Phone and URL.
- A dropdown can have up to 100 unique options, each up to 100 characters.

## Troubleshooting
- **"A field with this key already exists for this record type."** Change the **Key** to a unique value.
- **Key error?** Use lowercase letters, digits and underscores, start with a letter, maximum 40 characters.
- **No New field button?** Your role cannot manage custom fields. Ask an Owner or Admin.
