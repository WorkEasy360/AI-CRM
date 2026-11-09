## Pipeline

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Create pipeline | /settings/pipelines | Settings → CRM Configuration → Pipelines & Stages | pipelines.manage | Pipeline name*, Stages from (template: Sales pipeline, Inbound enquiries, Services engagements, Renewals, Partnerships) | New pipeline, Create pipeline | pipeline-create |
| Rename / archive pipeline | /settings/pipelines | same | pipelines.manage | Pipeline name* | ⋯ → Rename, Archive (blocked if default, open deals or active sub-pipelines) | pipeline-edit-delete |
| Default pipeline | /settings/pipelines | same | pipelines.manage | none | ⋯ → Make default | pipeline-default |
| Sub-pipeline | /settings/pipelines | same | pipelines.manage | Pipeline name*, Stages from | ⋯ → Add sub-pipeline (max 10, no plan count) | pipeline-sub-pipeline |
| Add stage | /settings/pipelines | same | pipelines.manage | Name*, Kind* (Open/Won/Lost), Probability %* (0–100, open only), Colour, Description | Add stage, Save stage | pipeline-add-stage |
| Edit stage / win probability | /settings/pipelines | same | pipelines.manage | as above | Edit (pencil), Save stage, Cancel | pipeline-edit-stage |
| Reorder stages | /settings/pipelines | same | pipelines.manage | none | Drag rows, Move up / Move down | pipeline-reorder-stages |
| Archive stage | /settings/pipelines | same | pipelines.manage | none | Archive → Archive stage (stage must be empty; keep one open/won/lost) | pipeline-archive-stage |
| Pipeline access | /settings/pipelines | same | pipelines.manage | Restrict to teams or roles switch, Teams, Roles | Save access | pipeline-restrict-access |
| Card layout | /settings/pipelines | same | pipelines.manage | up to 8 deal fields | Save layout | pipeline-card-layout |
| Switch pipeline | /pipeline | Pipeline | deals.view | Pipeline drop-down; Pipelines column (xl screens); Sub-pipelines chips | select | pipeline-switch |
| Kanban view | /pipeline | Pipeline → Kanban | deals.view | Sort (Recently moved, Amount high–low, Closing soonest, Name A–Z) | Show N more, KPI tiles | pipeline-kanban-view |
| List view | /pipeline?view=list | Pipeline → List | deals.view | View (All/My/Archived deals), Search, Filters (Status, Stage), Sort | Load more, row → deal page | pipeline-list-view |
| Forecast | /pipeline?tab=forecast | Pipeline → Forecast | reports.view | Period (This month/This quarter/Custom + From/To), Pipeline, Group by (Stage/Salesperson/Team/Pipeline) | tiles, By month, breakdown | pipeline-forecast |
| Analytics | /pipeline?tab=analytics | Pipeline → Analytics | deals.view | Pipeline, Search, Owner, Source, Product filters | Conversion by stage, Win / loss, Deals by source, Owner performance | pipeline-analytics |
| Sheet / Calendar / Chart views | /pipeline?view=sheet (calendar, chart) | Pipeline → view switcher | deals.view (deals.update to edit cells) | Columns; Place by; Measure / Group by | Save N rows, Discard, Show table | pipeline-more-views |
| Filters | /pipeline | Pipeline → Kanban | deals.view | Search deals…, All Owners/My deals, All Sources, All Products, Any status | Clear | pipeline-filter-deals |
| Saved views | /pipeline | Pipeline → Saved views | deals.view (views.share to share) | Name*, Who can use it (Only me/Everyone/Selected teams), Open with this view by default | Save as new view…, Save changes, Delete view, default | pipeline-saved-views |
| Create deal | /pipeline (also ?new=1) | Pipeline → Add Deal | deals.create | Deal name*, Currency* (prefilled), Company, Primary contact, Amount, Rate to (foreign currency), Expected close, Priority, Source, Description, Owner (deals.reassign), custom fields | Create deal, Create company, Create contact | deal-create |
| Add deal from column | /pipeline | Pipeline → Kanban | deals.create | same form | column Add Deal | deal-add-from-column |
| Deal details panel / page | /pipeline → /deals/[id] | Pipeline → card name → Open full deal | deals.view | Deal Value, Expected Close, Owner, Source, Product (inline) | tabs Overview, Timeline, Contacts, Products, Connected, Activities, Communication, AI Insights, Notes, Files | deal-open-details |
| Edit deal | /deals/[id] | Deal page → Edit | deals.update | same as create (amount read-only if from lines) | Save changes; card ⋯ → Edit details… (Name, Amount, Expected close) | deal-edit |
| Move stage / drag & drop | /pipeline | Pipeline → Kanban | deals.change_stage | Lost reason (optional, 255) for lost stages | drag, card ⋯ → Move to…, deal page Move to…, stage track | deal-drag-drop |
| Move to Next Stage | /pipeline | Deal Details panel | deals.change_stage | none | Move to Next Stage (skips lost stages) | deal-move-next-stage |
| Won / lost | /deals/[id] | Deal page stage track | deals.change_stage | Lost reason (optional) | Win, Lose → Mark as lost | deal-mark-won-lost |
| Notes / files | /pipeline, /deals/[id] | Deal Details → Notes / Files | notes.create, files.upload | note text (plain); file ≤ 10 MB | Add note, Choose a file | deal-notes-files |
| Activities | /pipeline, /deals/[id] | Deal Details quick actions; Activities tab | activities.create | activity form | Call, Task, Meeting, Email, WhatsApp, Note | deal-activities |
| Delete deal | /deals/[id] | Deal page → Delete | deals.delete | none | Delete (archives; Archived deals list) | deal-delete |
| Export deals | /settings/data | Settings → Security & Data → Import & Export Data | deals.export | Record type | Request export, Export everything, Download | deal-export |

### Not in product
- Bulk actions on deals (select rows, bulk move/reassign/delete): the deals List View has no row selection; the API `bulk` action exists but no UI. Multi-row editing is only possible in the Sheet view.
- Export button on the Pipeline page itself (export is only under Settings → Import & Export Data; list filters are not applied).
- Choosing the pipeline inside the Create Deal form: there is no Pipeline field; a new deal goes to the pipeline selected on the board.
- Manually overriding a deal's probability from the deal form or panel (the API supports it and the UI shows a "manual" badge, but no field edits it outside the Sheet view, unverified).
- Permanent (hard) delete of pipelines, stages or deals: everything is archived.
- Restore button on a deleted deal page: gated on a `deals.restore` permission that does not exist in the catalogue (backend restore uses `deals.delete`), so it never shows.
- Opening the deal page on the Products tab from the "Add a product" link: the link adds `?tab=products` but the deal page always opens on Overview.

## Products

| Feature | Route | Menu path | Permission | Fields (required*/optional) | Main actions | Article |
|---|---|---|---|---|---|---|
| Add product | /products (also ?new=1) | Products | products.create | Name*, SKU (unique), Status, Unit price, Currency, Tax rate (%), Tax label, Stock, Owner (all-scope update), Description, custom fields | Product / Add product, Create product, Import products | products-add |
| Edit / archive / restore product | /products, /products/[id] | Products → ⋯ | products.update, products.delete | as above | Edit, Archive, Restore (Archived products view), More actions | products-edit-delete |
| Create price book | /settings/price-books | Settings → Also in Settings → Price books | pricebooks.manage | Name*, Currency* (fixed after create), Description | New price book, Create price book | products-price-book-create |
| Price book prices | /settings/price-books | same → Prices | pricebooks.manage (view: products.view) | Find product, Product*, Price* | Add, Save, Remove | products-price-book-prices |
| Edit / deactivate / archive price book | /settings/price-books | same → ⋯ | pricebooks.manage | Name, Description | Edit, Deactivate/Activate, Archive | products-price-book-edit |
| Products on a deal (line items) | /deals/[id] | Deal page → Products tab | deals.update | Product*, Quantity*, Unit price, Discount (%), Tax rate (%) | Add product, edit, Remove | products-add-to-deal |
| Price book on a deal | /deals/[id] | Deal page → Products tab | deals.update | Price book (List prices or a book in the deal currency) | select | products-use-price-book-on-deal |

### Not in product
- Bulk actions on products (the API refuses `bulk`; no selection UI).
- Product categories, product images or stock quantities (stock is only an In stock / Out of stock switch).
- Adding products while creating a deal: lines can only be added once the deal is saved.
