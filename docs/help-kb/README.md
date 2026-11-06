# Help knowledge base

The product guide WorkEasy AI answers "how do I…" questions from. One Markdown article per task in
`articles/`; the backend serves them (`backend/apps/helpkb`), the Help Center lists them, and the
assistant answers only from them.

| Path | What it is |
|---|---|
| `articles/<id>.md` | One article per feature or task (format below). |
| `feature-inventory.md` | Every feature: route, menu path, permission, fields, actions, article. Generated from `inventory/*.md`. |
| `eval.json` | Retrieval eval: real questions (English, Hindi, Hinglish) and the article each should find. Generated from `eval/*.json`. |

## Workflow

```bash
python scripts/help_kb.py build   # after editing articles: refresh the backend bundle, inventory and eval
python scripts/help_kb.py check   # what CI runs: article format, links, permissions, route coverage, bundle freshness
python scripts/help_kb.py eval    # retrieval accuracy (fails below 90% top-1)
```

`check` fails when a page under `frontend/src/app` has no article whose `route` points at it. Add an
article, or, for a page that is only a redirect or an emailed link, an entry in `EXEMPT_ROUTES` in
`scripts/help_kb.py` saying which article covers it.

Deploys sync the bundle into the database on `migrate`. Workspace admins add their own articles, or
override one of these for their workspace only, under **Settings → AI Assistant → Knowledge Base**.

## Article format

```markdown
---
id: pipeline-create
title: How to Create a New Pipeline
question: How do I create a pipeline?
module: Pipeline
keywords: [pipeline, create pipeline, new pipeline, naya pipeline, pipeline kaise banaye, पाइपलाइन]
route: /settings/pipelines
menu_path: Settings → CRM Configuration → Pipelines & Stages
spotlight: New pipeline
permission: pipelines.manage
related: [pipeline-add-stage, deal-create]
updated: 2026-11-06
---

## Overview
## Before you start      (optional)
## Steps                 (numbered, one action each, UI labels in **bold**)
## Result
## Tips                  (optional)
## Troubleshooting       (optional)
```

- Frontmatter: one `key: value` per line; lists inline as `[a, b]`; list items without commas.
- `module` is one of: Getting Started, Dashboard, Pipeline, Contacts, Activities, AI Assistant,
  Helpdesk, Products, Settings, FAQ.
- `route` must be a page in the app. `permission` must be a code from `backend/apps/authz/catalogue.py`
  (omit it when every member can do the task). `spotlight` is the exact visible label of the button to
  highlight after "Take me there".
- Every UI label must match the software exactly. The assistant rejects any answer that uses a bold
  label the article does not contain, so a wrong label in an article is a wrong answer.
- No HTML.
