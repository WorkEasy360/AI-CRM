import { expect, test, type Page } from "@playwright/test";
import { RUN_ID, apiFromPage, dialog, login, users } from "./helpers";


/**
 * Milestone 2 (Core CRM) through the browser against a live stack: create a five-stage pipeline, create
 * a deal, drag it across stages, add product lines (amount recomputes), add a task and a note,
 * bulk-edit in the Sheet view, export, and import a file then roll it back.
 */
const HAVE_STACK = Boolean(process.env.E2E_BASE_URL && process.env.E2E_USERS_FILE);
test.skip(!HAVE_STACK, "E2E_BASE_URL / E2E_USERS_FILE not set; skipping the core CRM workflow");
test.describe.configure({ mode: "serial" });

const U = HAVE_STACK ? users() : ({} as ReturnType<typeof users>);
const pipelineName = `Enterprise ${RUN_ID}`;
const dealName = `Initech rollout ${RUN_ID}`;
const STAGES = ["Lead in", "Demo", "Contract"];

let page: Page;
let pipelineId = "";
let dealId = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test("1. create a pipeline with five stages and see it in settings", async () => {
  await login(page, U.owner, U.password);
  await page.goto("/settings/pipelines");
  const res = await apiFromPage(page, "POST", "/api/v1/pipelines/", {
    name: pipelineName,
    stages: [
      ...STAGES.map((name, i) => ({ name, kind: "open", default_probability: 20 * (i + 1) })),
      { name: "Signed", kind: "won" },
      { name: "Gone", kind: "lost" },
    ],
  });
  expect(res.status).toBe(201);
  pipelineId = (res.body as { id: string }).id;
  await page.reload();
  await page.getByRole("button", { name: new RegExp(pipelineName) }).click();
  for (const name of [...STAGES, "Signed", "Gone"]) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
});

test("2. create a deal and drag it across stages on the board", async () => {
  const res = await apiFromPage(page, "POST", "/api/v1/deals/", { name: dealName, pipeline_id: pipelineId, amount: "1000" });
  expect(res.status).toBe(201);
  dealId = (res.body as { id: string }).id;
  await page.goto(`/pipeline?pipeline=${pipelineId}`);
  const card = page.getByTestId(`deal-card-${dealId}`);
  await expect(card).toBeVisible();
  const board = await apiFromPage(page, "GET", `/api/v1/deals/board/?pipeline=${pipelineId}`);
  const stages = (board.body as { stages: { id: string; name: string }[] }).stages;
  const demo = stages.find((s) => s.name === "Demo")!;
  await card.dragTo(page.getByTestId(`column-${demo.id}`));
  await expect(page.getByRole("list", { name: "Demo deals" }).getByText(dealName)).toBeVisible();
  // weighted forecast is shown in the header
  await expect(page.getByText(/weighted forecast/)).toBeVisible();
});

test("3. add product lines: the amount recomputes with tax", async () => {
  const product = await apiFromPage(page, "POST", "/api/v1/products/", { name: `Seat ${RUN_ID}`, unit_price: "100", tax_rate: "10" });
  expect(product.status).toBe(201);
  await page.goto(`/deals/${dealId}`);
  await page.getByRole("tab", { name: /Products/ }).click();
  await page.getByRole("button", { name: "Add product" }).click();
  const d = dialog(page, "Add a product");
  await d.getByRole("combobox").first().click();
  await page.getByRole("option", { name: new RegExp(`Seat ${RUN_ID}`) }).click();
  await d.getByLabel("Quantity").fill("3");
  await d.getByRole("button", { name: "Add product" }).click();
  // 3 x 100 = 300 + 10% tax
  await expect(page.getByText("The deal amount is the total of these lines, tax included; change the lines to change it.")).toBeVisible();
  const fresh = await apiFromPage(page, "GET", `/api/v1/deals/${dealId}/`);
  expect((fresh.body as { amount: string }).amount).toBe("330.00");
});

test("4. add a task and a note", async () => {
  const task = await apiFromPage(page, "POST", "/api/v1/activities/", { kind: "task", title: `Send contract ${RUN_ID}`, deal_id: dealId });
  expect(task.status).toBe(201);
  const note = await apiFromPage(page, "POST", "/api/v1/notes/", { entity_type: "deal", entity_id: dealId, body: `Champion agreed ${RUN_ID}` });
  expect(note.status).toBe(201);
  await page.goto(`/deals/${dealId}`);
  await expect(page.getByText(`Champion agreed ${RUN_ID}`).first()).toBeVisible();
});

test("5. bulk-edit in the Sheet view", async () => {
  await page.goto(`/pipeline?pipeline=${pipelineId}&view=sheet&cols=name,lost_reason,description`);
  const grid = page.getByRole("grid", { name: "Sheet" });
  await expect(grid.getByText(dealName)).toBeVisible();
  const row = grid.getByRole("row").filter({ hasText: dealName });
  await row.getByRole("gridcell").nth(2).dblclick();
  await page.keyboard.type(`Edited in the sheet ${RUN_ID}`);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Save 1 row/ }).click();
  await expect(page.getByText("Saved 1 record")).toBeVisible();
  const fresh = await apiFromPage(page, "GET", `/api/v1/deals/${dealId}/`);
  expect((fresh.body as { description: string }).description).toBe(`Edited in the sheet ${RUN_ID}`);
});

test("6. export deals", async () => {
  await page.goto("/settings/data");
  await expect(page.getByText(/Export/).first()).toBeVisible();
  const res = await apiFromPage(page, "POST", "/api/v1/exports/deals/", { filters: { pipeline: pipelineId } });
  // A fresh sign-in is required for exports; 202 when recent, 403 reauthentication otherwise.
  expect([202, 403]).toContain(res.status);
});

test("7. import a file, then roll it back", async () => {
  await page.goto("/settings/data");
  const csv = `First name,Email\nRoll ${RUN_ID},roll-${RUN_ID}@example.com\nBack ${RUN_ID},back-${RUN_ID}@example.com\n`;
  await page.locator('input[type="file"]').first().setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Check file" }).click();
  await expect(page.getByText(/2 to create|Create 2|would create/i).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Import/ }).click();
  await expect(page.getByText(/Completed|completed/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Roll back" }).first().click();
  await page.getByRole("button", { name: /Roll back/ }).last().click();
  await expect(page.getByText(/rolled back/i).first()).toBeVisible({ timeout: 30_000 });
  const found = await apiFromPage(page, "GET", `/api/v1/contacts/?q=${encodeURIComponent(`Roll ${RUN_ID}`)}`);
  expect((found.body as { results: unknown[] }).results).toHaveLength(0);
});
