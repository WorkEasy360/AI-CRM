---
id: pipeline-add-stage
title: How to Add a Stage to a Pipeline
question: How do I add a new stage to my pipeline?
module: Pipeline
keywords: [add stage, new stage, pipeline stage, deal stage, column, kanban column, stage add kaise kare, naya stage, स्टेज जोड़ें, चरण]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
spotlight: Add stage
permission: pipelines.manage
related: [pipeline-edit-stage, pipeline-reorder-stages, pipeline-archive-stage, pipeline-create]
updated: 2026-11-06
---

## Overview
Each stage becomes a column on the Kanban board. Add stages to match the steps of your sales process.

## Before you start
- You need `pipelines.manage` (Owner, Admin or Sales Manager).
- A pipeline can have up to 30 stages.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Pipelines & Stages**.
3. In the list on the left, click the pipeline you want to change.
4. Click **Add stage** above the stages table.
5. Type the stage **Name**.
6. Choose its **Kind**: **Open**, **Won** or **Lost**.
7. Enter **Probability %** (0 to 100) for an open stage.
8. Pick a **Colour** and, optionally, type a **Description**.
9. Click the check mark button (**Save stage**).

## Result
"Stage added" appears and the stage is added at the end of the table. It shows as a new column on the board.

## Tips
- Choosing **Won** sets the probability to 100 and **Lost** sets it to 0; the field is locked for these kinds.
- Drag the new row or use its arrows to put it in the right place.

## Troubleshooting
- **"Duplicate stage name".** Two stages in one pipeline cannot share a name.
