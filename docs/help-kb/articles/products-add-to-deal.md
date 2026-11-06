---
id: products-add-to-deal
title: How to Add Products to a Deal
question: How do I add products or line items to a deal?
module: Products
keywords: [add product to deal, line items, deal products, quote, quantity, discount, tax, deal mein product kaise jode, quotation banana, उत्पाद जोड़ें, डील उत्पाद]
route: /pipeline
menu_path: Pipeline → Deal Details → Open full deal → Products
permission: deals.update
related: [products-use-price-book-on-deal, products-add, deal-edit, deal-create]
updated: 2026-11-06
---

## Overview
Product lines turn a deal into a quote: each line has a product, quantity, price, discount and tax. The deal amount then becomes the total of the lines, tax included.

## Before you start
- You need `deals.update` for the deal. A Sales Representative can do this on their own deals.
- The deal must already be saved, and the product must exist and be **Active**.

## Steps
1. Click **Pipeline** in the left sidebar.
2. Click the deal's name on its card, then click **Open full deal**.
3. Click the **Products** tab.
4. Click **Add product**.
5. Choose the product in **Product**. Its tax rate and, unless the deal uses a price book, its list price fill in.
6. Enter the **Quantity**.
7. Optionally change **Unit price**, **Discount (%)** or **Tax rate (%)**.
8. Click **Add product**.

## Result
"Product added" appears. The line is shown with its subtotal, tax and line total, and a **Total** row sums all lines. The deal amount updates to that total.

## Tips
- Click the pencil button on a line to change it, or the bin button and then **Remove** to delete it. The product itself is kept.
- Leave **Unit price** blank to use the list price, or the price book price if the deal uses one.
- Tax is charged on the discounted price.
- When all lines are removed, you can type the deal amount yourself again.

## Troubleshooting
- **"No active products."** Ask an Admin to add products or set them to **Active**.
- **The Add a product link in Deal Details opens the Overview tab.** Click the **Products** tab on the deal page.
