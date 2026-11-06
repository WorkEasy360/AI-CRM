---
id: pipeline-sub-pipeline
title: How to Add a Sub-pipeline
question: How do I create a sub-pipeline under an existing pipeline?
module: Pipeline
keywords: [sub-pipeline, sub pipeline, pipeline variant, child pipeline, separate stages, sub pipeline kaise banaye, pipeline ke andar pipeline, उप पाइपलाइन]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
permission: pipelines.manage
related: [pipeline-create, pipeline-restrict-access, pipeline-card-layout, pipeline-switch]
updated: 2026-11-06
---

## Overview
A sub-pipeline is a variant of a team pipeline with its own stages. It shares the parent's access rules and card layout, and does not count towards your plan's pipeline limit. Use it when one team sells in slightly different ways, for example online and field sales.

## Before you start
- You need `pipelines.manage` (Owner, Admin or Sales Manager).
- A pipeline can have up to 10 sub-pipelines. A sub-pipeline cannot have sub-pipelines of its own.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Pipelines & Stages**.
3. In the list on the left, click the **⋯** button next to the parent pipeline.
4. Click **Add sub-pipeline**.
5. Type a **Pipeline name**.
6. Choose a template in **Stages from**.
7. Click **Create pipeline**.

## Result
The sub-pipeline appears indented under its parent. On the **Pipeline** board, buttons for the parent and its sub-pipelines appear above the columns so you can switch between them.

## Tips
- A sub-pipeline cannot be made the default pipeline.
- To change who sees it, change the access of the parent pipeline.
