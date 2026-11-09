---
id: pipeline-forecast
title: How to Use the Pipeline Forecast
question: How do I see the sales forecast for this month or quarter?
module: Pipeline
keywords: [forecast, sales forecast, revenue forecast, weighted revenue, expected revenue, committed, quarter, month, forecast kaise dekhe, kitna revenue aayega, पूर्वानुमान, राजस्व]
route: /pipeline?tab=forecast
menu_path: Pipeline → Forecast
spotlight: Forecast
permission: reports.view
related: [pipeline-analytics, pipeline-edit-stage, pipeline-kanban-view]
updated: 2026-11-06
---

## Overview
The Forecast tab adds up open deals by their expected close date, weighted by probability (value × probability). It is arithmetic on today's pipeline, not a prediction.

## Before you start
- You need the Reports permission (`reports.view`). All standard roles have it; a Sales Representative sees team figures.

## Steps
1. Click **Pipeline** in the left sidebar.
2. Click **Forecast** in the view tabs.
3. Choose the **Period**: **This month**, **This quarter** or **Custom**. For **Custom**, set the **From** and **To** dates.
4. If you have several pipelines, choose one or keep **All pipelines**.
5. In **Group by**, choose **Stage**, **Salesperson**, **Team** or **Pipeline**.

## Result
Tiles show **Pipeline value**, **Weighted**, **Committed** (deals at or above the committed probability), **Won so far** and **Expected revenue** (weighted plus won). The **By month** panel and the breakdown table show the same figures per month and per group.

## Tips
- Click the **Pipeline value** or **Won so far** tile to open the matching deals in the List view.
- Deals without an expected close date are not in the forecast. Set a date on each open deal.

## Troubleshooting
- **"Forecast is not available for your role".** Ask an administrator for the Reports permission.
- **"Choose a date range".** With **Custom**, both dates are required.
