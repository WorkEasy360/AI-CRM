---
id: pipeline-kanban-view
title: How to Use the Kanban View of the Pipeline
question: How does the Kanban board work?
module: Pipeline
keywords: [kanban, board, kanban view, pipeline board, columns, deal cards, weighted, stage total, kanban kaise use kare, board dekhna, कानबन, बोर्ड]
route: /pipeline
menu_path: Pipeline → Kanban
spotlight: Kanban
permission: deals.view
related: [deal-drag-drop, deal-add-from-column, pipeline-filter-deals, pipeline-card-layout]
updated: 2026-11-09
---

## Overview
The Kanban view shows the selected pipeline as columns, one per stage, with a card for each deal. It is the default view of the **Pipeline** page.

## Steps
1. Click **Pipeline** in the left sidebar.
2. Click **Kanban** in the view tabs.
3. Read each column header: the stage name, the number of deals and the total amount. Click **⋯** on a column to see the **Weighted** amount of an open stage.
4. Read a card: deal name, amount, contact (or company), owner, and the next follow-up date. Closed deals show **Won** or **Lost** and the date they closed.
5. Use the card's buttons: the phone calls the contact, the message icon opens WhatsApp, and **Follow-up** schedules a task for the deal.
6. Click a deal name to open the **Deal Details** panel.

## Result
You see where every deal stands and what each stage is worth.

## Tips
- A card with **No next step** has no scheduled activity. Plan one so the deal does not stall.
- A follow-up date in red has already passed. Call and WhatsApp are greyed out when the contact has no phone number you can see.
- Won and lost deals follow the period menu (**This Month** by default). Open deals always stay on the board. Choose **All Time** to see every closed deal.
- Columns load up to 200 cards at first. Click **Show … more** at the bottom of a column to load the rest.
- Click **Filters**, then use the **Sort** drop-down to order cards by **Recently moved**, **Amount high–low**, **Closing soonest** or **Name A–Z**.
- The summary above the board shows **Open Pipeline Value**, **Total Deals**, **Open Deals**, **Won Deals**, **Lost Deals** and **Conversion Rate** (won ÷ won + lost) for the selected period. **Expected Revenue**, **Win Rate** and **Avg. Deal Cycle** are on the **Analytics** tab.

## Troubleshooting
- **"This pipeline has no active stages yet."** Add stages under **Settings → CRM Configuration → Pipelines & Stages**.
