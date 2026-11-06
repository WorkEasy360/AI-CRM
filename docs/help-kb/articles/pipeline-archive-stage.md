---
id: pipeline-archive-stage
title: How to Remove (Archive) a Stage
question: How do I delete a stage from a pipeline?
module: Pipeline
keywords: [delete stage, remove stage, archive stage, unused stage, remove column, stage hatana, stage delete kaise kare, स्टेज हटाएं]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
permission: pipelines.manage
related: [pipeline-add-stage, pipeline-edit-stage, deal-drag-drop]
updated: 2026-11-06
---

## Overview
A stage you no longer use can be archived. It disappears from the stages table and from the Kanban board. Stages are archived, not permanently deleted.

## Before you start
- You need `pipelines.manage` (Owner, Admin or Sales Manager).
- The stage must be empty: move its deals to another stage first.
- A pipeline must always keep at least one Open, one Won and one Lost stage.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Pipelines & Stages**.
3. In the list on the left, click the pipeline.
4. On the stage row, click the archive button (labelled "Archive" followed by the stage name).
5. Click **Archive stage** in the confirmation dialog.

## Result
"Stage archived" appears and the stage is removed from the table and the board.

## Troubleshooting
- **"Move the deals out of this stage first."** The stage still has deals. On the **Pipeline** page, drag them to another column, then try again.
- **The archive is refused for a Won or Lost stage.** It is the last one of its kind. Add another stage of that kind first.
