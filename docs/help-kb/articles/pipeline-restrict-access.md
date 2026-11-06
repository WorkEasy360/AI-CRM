---
id: pipeline-restrict-access
title: How to Restrict a Pipeline to Certain Teams or Roles
question: How do I make a pipeline visible only to some teams?
module: Pipeline
keywords: [restrict pipeline, pipeline access, private pipeline, team pipeline, who can see pipeline, permissions, hide pipeline, pipeline access kaise de, sirf team ko dikhe, पहुंच, प्रतिबंधित]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
permission: pipelines.manage
related: [pipeline-create, pipeline-card-layout, settings-roles-permissions, pipeline-switch]
updated: 2026-11-06
---

## Overview
By default every member who can see deals sees every pipeline. You can restrict a pipeline so that only chosen teams and roles see it and its deals. Members who manage pipelines always see every pipeline.

## Before you start
- You need `pipelines.manage` (Owner, Admin or Sales Manager).
- Create the teams first under **Settings → Workspace → Users & Teams**.
- Sub-pipelines follow their parent pipeline's access and cannot be restricted on their own.

## Steps
1. Click **Settings** in the left sidebar.
2. In the **CRM Configuration** card, click **Pipelines & Stages**.
3. In the list on the left, click the pipeline.
4. In the card below the stages, turn on the **Restrict to teams or roles** switch.
5. Under **Teams**, tick the teams that may use the pipeline.
6. Under **Roles**, tick the roles that may use it.
7. Click **Save access**.

## Result
"Access saved" appears and the pipeline shows a **Restricted** badge in settings and a lock icon in the **Pipelines** column of the Pipeline page. Members outside the chosen teams and roles no longer see it.

## Tips
- Turning the switch off makes the pipeline visible to everyone again.

## Troubleshooting
- **No teams are listed ("No teams yet.").** Create a team first, then return to this page.
