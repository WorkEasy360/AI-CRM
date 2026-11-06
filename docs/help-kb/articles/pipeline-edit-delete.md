---
id: pipeline-edit-delete
title: How to Rename or Archive (Delete) a Pipeline
question: How do I rename or delete a pipeline?
module: Pipeline
keywords: [rename pipeline, edit pipeline, delete pipeline, archive pipeline, remove pipeline, pipeline name, pipeline delete kaise kare, pipeline ka naam badle, पाइपलाइन हटाएं, नाम बदलें]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
permission: pipelines.manage
related: [pipeline-create, pipeline-default, pipeline-archive-stage]
updated: 2026-11-06
---

## Overview
You can rename a pipeline at any time. When a pipeline is no longer needed, you archive it: it is hidden from the board but its history is kept. There is no permanent delete.

## Before you start
- You need `pipelines.manage` (Owner, Admin or Sales Manager).
- To archive, the pipeline must not be the default, must have no open deals and no active sub-pipelines.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Pipelines & Stages**.
3. In the list on the left, click the **⋯** button next to the pipeline (its label is "Actions for" followed by the pipeline name).
4. To rename, click **Rename**, change **Pipeline name** and click **Save**.
5. To delete, click **Archive**, then click **Archive pipeline** in the confirmation dialog.

## Result
A rename shows "Pipeline renamed"; deals keep their stages and only the name changes. An archive shows "Pipeline archived" and the pipeline disappears from the board and the pipeline list.

## Troubleshooting
- **Archive is greyed out.** It is the default pipeline. Make another pipeline the default first.
- **"Could not archive pipeline".** Move or close (win or lose) its open deals, and archive its sub-pipelines first.
- **"This pipeline changed in the meantime."** Someone else edited it. Close the dialog and try again.
