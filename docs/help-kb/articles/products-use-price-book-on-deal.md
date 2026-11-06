---
id: products-use-price-book-on-deal
title: How to Use a Price Book on a Deal
question: How do I apply price book prices to a deal?
module: Products
keywords: [price book on deal, apply price book, deal pricing, special price, list prices, wholesale, deal par price book, price book kaise lagaye, मूल्य सूची लागू]
route: /pipeline
menu_path: Pipeline → Deal Details → Open full deal → Products
permission: deals.update
related: [products-add-to-deal, products-price-book-create, products-price-book-prices]
updated: 2026-11-06
---

## Overview
By default, product lines on a deal use each product's list price. Choose a price book on the deal to price its lines from that book instead.

## Before you start
- You need `deals.update` for the deal.
- An active price book in the same currency as the deal must exist.

## Steps
1. Click **Pipeline** in the left sidebar.
2. Click the deal's name on its card, then click **Open full deal**.
3. Click the **Products** tab.
4. Open the **Price book** drop-down next to **Add product** (it shows **List prices** by default).
5. Choose the price book.
6. Click **Add product** to add lines priced from the book.

## Result
The drop-down shows the chosen book. New lines with a blank **Unit price** take the price from the book; products not in the book use their list price.

## Tips
- Choose **List prices** to stop using the book.
- Members who cannot edit the deal see "Prices from" followed by the book name.

## Troubleshooting
- **No Price book drop-down.** There is no active price book in the deal's currency. Create one under **Settings → Price books**, or check the deal currency.
