---
id: pipeline-edit-stage
title: How to Rename a Stage or Change Its Win Probability
question: How do I rename a stage or change its probability?
module: Pipeline
keywords: [edit stage, rename stage, stage probability, win probability, stage colour, stage kind, weighted value, probability kaise badle, stage ka naam badle, संभावना, स्टेज बदलें]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
permission: pipelines.manage
related: [pipeline-add-stage, pipeline-reorder-stages, pipeline-kanban-view, pipeline-forecast]
updated: 2026-11-06
---

## Overview
Every stage has a name, a kind (Open, Won or Lost), a win probability, a colour and an optional description. The probability drives the weighted values on the board and in the forecast (value × probability).

## Before you start
- You need `pipelines.manage` (Owner, Admin or Sales Manager).

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Pipelines & Stages**.
3. In the list on the left, click the pipeline.
4. In the stages table, click the pencil button on the stage row (labelled "Edit" followed by the stage name).
5. Change **Name**, **Kind**, **Probability %**, **Colour** or **Description**.
6. Click the check mark button (**Save stage**), or click **Cancel** (X) to discard.

## Result
"Stage updated" appears. The board shows the new name and colour. A deal that moves into the stage takes the stage's probability.

## Tips
- **Probability %** must be a whole number from 0 to 100. It can only be edited for **Open** stages; Won is always 100 and Lost is always 0.
- Renaming a stage does not move any deals.

## Troubleshooting
- **"A pipeline needs at least one won stage and one lost stage."** You cannot change the kind of the last Won or Lost stage. Add another one first.
