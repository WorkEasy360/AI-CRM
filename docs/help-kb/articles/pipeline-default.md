---
id: pipeline-default
title: How to Set the Default Pipeline
question: How do I change the default pipeline?
module: Pipeline
keywords: [default pipeline, make default, main pipeline, primary pipeline, star, default set kare, default pipeline kaise badle, डिफ़ॉल्ट पाइपलाइन]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
permission: pipelines.manage
related: [pipeline-create, pipeline-switch, pipeline-edit-delete]
updated: 2026-11-06
---

## Overview
The default pipeline is the one the **Pipeline** page opens with and the one new deals go to when no other pipeline is selected. Exactly one pipeline is the default.

## Before you start
- You need `pipelines.manage` (Owner, Admin or Sales Manager).
- Sub-pipelines cannot be the default.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Pipelines & Stages**.
3. In the list on the left, click the **⋯** button next to the pipeline you want.
4. Click **Make default**.

## Result
A "Default pipeline updated" message appears and the **Default** badge moves to that pipeline. The **Pipeline** page now opens on it.

## Tips
- **Make default** is not shown for the pipeline that is already the default.
- To retire the current default pipeline, first make another one the default, then archive the old one.
