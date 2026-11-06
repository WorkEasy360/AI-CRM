---
id: settings-create-custom-role
title: How to Create a Custom Role (Profile)
question: How do I create a custom role with my own permissions?
module: Settings
keywords: [custom role, new profile, create role, edit permissions, permission set, copy permissions, delete role, naya role banaye, custom permission kaise de, कस्टम भूमिका, नई प्रोफ़ाइल]
route: /settings/roles
menu_path: Settings → Workspace → Roles & Permissions → Profiles
spotlight: New profile
permission: roles.manage
related: [settings-roles-permissions, settings-change-role, settings-field-permissions]
updated: 2026-11-06
---

## Overview
If no built-in role fits, create a custom profile. You start from an existing role and then change what each permission allows.

## Before you start
- The Owner and Admins can create profiles. You cannot grant a permission you do not hold yourself, and billing stays reserved for the Owner.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **Workspace** card, click **Roles & Permissions**.
3. On the **Profiles** tab, click **New profile**.
4. Enter a **Name**.
5. Under **Copy permissions from**, choose the role to start from.
6. Click **Create**.
7. In the profile on the right, change the access level next to each permission (for example **Own records** or **No access**).
8. Click **Save**.

## Result
A message says **Profile saved**. The new profile appears in the list and can be chosen in **Invite user** and **Change role**.

## Tips
- To delete a custom profile, select it and click **Delete**. Move everyone off the profile first; the button stays disabled while it has members.
- A workspace can have up to 50 custom profiles.

## Troubleshooting
- **"You cannot grant permissions you do not hold".** Remove the listed permissions or ask the Owner to create the profile.
- **"A role with this name already exists."** Choose a different name.
- **The access drop-downs are greyed out.** You selected a **System** profile, which cannot be changed.
