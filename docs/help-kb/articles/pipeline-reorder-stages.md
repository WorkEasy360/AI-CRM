---
id: pipeline-reorder-stages
title: How to Reorder Pipeline Stages
question: How do I change the order of stages?
module: Pipeline
keywords: [reorder stages, stage order, move stage up, move stage down, drag stage, sort stages, column order, stage order kaise badle, stage upar niche, क्रम बदलें, स्टेज क्रम]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
permission: pipelines.manage
related: [pipeline-add-stage, pipeline-edit-stage, pipeline-kanban-view]
updated: 2026-11-06
---

## Overview
The order of stages in settings is the order of the columns on the Kanban board, from left to right. Change it whenever your process changes.

## Before you start
- You need `pipelines.manage` (Owner, Admin or Sales Manager).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Pipelines & Stages**.
3. In the list on the left, click the pipeline.
4. Drag a stage row by its handle to a new position, or click the up arrow (**Move … up**) or down arrow (**Move … down**) on the row.

## Result
The new order saves immediately, as the hint above the table says ("Changes save immediately"). The board columns follow the new order.

## Tips
- The up arrow is disabled on the first row and the down arrow on the last row.
- You cannot drag rows while a stage is being edited. Save or cancel the edit first.

## Troubleshooting
- **"Could not reorder stages".** The table returns to the saved order. Reload the page and try again.
