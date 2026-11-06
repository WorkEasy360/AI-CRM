---
id: deal-drag-drop
title: How to Move a Deal to Another Stage
question: How do I move a deal to the next stage on the board?
module: Pipeline
keywords: [move deal, drag and drop, change stage, deal stage, move to stage, kanban drag, update stage, deal ko aage badhaye, stage kaise badle, drag karke move, स्टेज बदलें, डील आगे]
route: /pipeline
menu_path: Pipeline → Kanban View
permission: deals.change_stage
related: [deal-move-next-stage, deal-mark-won-lost, pipeline-kanban-view]
updated: 2026-11-06
---

## Overview
Moving a deal between stages records its progress and updates its probability to the new stage's value. On the board you can drag the card or use its menu.

## Before you start
- You need `deals.change_stage`. A Sales Representative can move only their own deals; Sales Manager, Admin and Owner can move any deal.

## Steps
1. Click **Pipeline** in the left sidebar.
2. Make sure **Kanban View** is selected.
3. Press and hold a deal card.
4. Drag it onto the column of the new stage and release it.

## Result
The card moves to the new column at once, and the column counts and totals update. If the new stage is a Lost stage, a **Mark as lost?** dialog asks for an optional reason first.

## Tips
- Without dragging: click the **⋯** button on the card and pick a stage under **Move to…**. Won and Lost stages are marked on the right.
- On the full deal page, use **Move to…** at the top, or click a stage name on the stage track.
- Moving a closed deal back to an open stage reopens it.

## Troubleshooting
- **"Someone else changed this deal."** The board was refreshed with the latest version. Try the move again.
- **"Not allowed".** You cannot change the stage of this deal, usually because it belongs to someone else.
- **Cards cannot be dragged.** Your role does not include changing stages.
