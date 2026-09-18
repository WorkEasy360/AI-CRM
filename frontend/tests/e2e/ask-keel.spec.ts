import { expect, test, type Page } from "@playwright/test";
import { RUN_ID, apiFromPage, login, users } from "./helpers";

/**
 * Ask Keel end to end, against a live stack (see helpers.ts):
 *
 *   login -> dashboard -> ask about a customer -> structured CRM facts + retrieved evidence + sources
 *         -> switch generative AI off (the user-visible equivalent of a provider outage)
 *         -> ask again: same interface, same facts, same sources, no written analysis
 *         -> switch it back on -> normal mode resumes
 *
 * Toggling the workspace policy is how an outage is simulated here on purpose: it is a real product
 * state an administrator can reach, and it exercises exactly the same retrieval-only rendering path.
 * Provider-level failures (timeout, 5xx, rate limit, exhausted budget, every model down) are covered
 * in backend/tests/crm/test_assistant.py, where they can be induced precisely.
 */
const HAVE_STACK = Boolean(process.env.E2E_BASE_URL && process.env.E2E_USERS_FILE);
test.skip(!HAVE_STACK, "E2E_BASE_URL / E2E_USERS_FILE not set; skipping Ask Keel workflow");
test.describe.configure({ mode: "serial" });

const U = HAVE_STACK ? users() : ({} as ReturnType<typeof users>);
const companyName = `Initech ${RUN_ID}`;
const dealName = `Initech rollout ${RUN_ID}`;
const NOTE = "Customer requested revised pricing before signing and asked about the rollout timeline.";

let page: Page;

async function setGenerativeAI(enabled: boolean): Promise<void> {
  const response = await apiFromPage(page, "PUT", "/api/v1/ai/settings/", { ai_enabled: enabled });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

/** Ask a question from the dashboard card and wait for the answer panel. */
async function ask(question: string) {
  await page.goto("/dashboard");
  const card = page.getByRole("region", { name: "Ask Keel" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByLabel("Ask Keel a question").fill(question);
  await card.getByRole("button", { name: "Ask" }).click();
  const panel = page.getByRole("dialog");
  // Which sections an answer carries depends on the question: a record question renders "From your CRM",
  // a communication search renders "From your conversations" only. Wait for the answer, not for one shape
  // of it; the tests that need a particular section assert it themselves.
  await expect(panel.getByRole("region").first()).toBeVisible({ timeout: 60_000 });
  return panel;
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  if (page && !page.isClosed()) {
    await setGenerativeAI(true).catch(() => undefined); // never leave the workspace in AI-off state
    await page.close();
  }
});

test("1. a customer with a deal and a conversation to find", async () => {
  await login(page, U.owner, U.password);

  const company = await apiFromPage(page, "POST", "/api/v1/companies/", { name: companyName });
  expect(company.status).toBe(201);
  const companyId = (company.body as { id: string }).id;

  const pipelines = await apiFromPage(page, "GET", "/api/v1/pipelines/");
  const pipeline = (pipelines.body as { results: { id: string; stages: { id: string; kind: string }[] }[] }).results.at(0);
  const stage = pipeline?.stages.find((s) => s.kind === "open") ?? pipeline?.stages.at(0);
  expect(pipeline, "the seeded organization must have a pipeline").toBeTruthy();
  expect(stage, "the pipeline must have an open stage").toBeTruthy();

  const deal = await apiFromPage(page, "POST", "/api/v1/deals/", {
    name: dealName,
    pipeline_id: pipeline!.id,
    stage_id: stage!.id,
    company_id: companyId,
    amount: "850000.00",
  });
  expect(deal.status).toBe(201);
  const dealId = (deal.body as { id: string }).id;

  const note = await apiFromPage(page, "POST", "/api/v1/notes/", {
    entity_type: "deal",
    entity_id: dealId,
    body: NOTE,
  });
  expect(note.status).toBe(201);
});

test("2. the dashboard offers one assistant, with suggested questions", async () => {
  await page.goto("/dashboard");
  const card = page.getByRole("region", { name: "Ask Keel" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText("Ask anything about your customers")).toBeVisible();
  await expect(card.getByRole("button", { name: /deals|pipeline|follow up/i }).first()).toBeVisible();
  // Global search stays a separate, faster thing; Ask Keel does not replace it.
  await expect(page.getByRole("button", { name: /search/i }).first()).toBeVisible();
});

test("3. with AI available: CRM facts, analysis and sources", async () => {
  await setGenerativeAI(true);
  const panel = await ask(`What happened with ${companyName}?`);

  await expect(panel.getByRole("region", { name: "From your CRM" })).toContainText(dealName);
  await expect(panel.getByRole("region", { name: "Keel's analysis" })).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole("region", { name: "Sources" })).toContainText(companyName);
  // Nothing technical is exposed to a salesperson.
  await expect(panel).not.toContainText(/anthropic|openai|pgvector|embedding|503/i);
});

test("4. the knowledge index finds what was written in the note", async () => {
  const panel = await ask("What did the customer say about pricing?");
  await expect(panel.getByText(/revised pricing/i).first()).toBeVisible({ timeout: 60_000 });
});

test("5. with AI unavailable: same interface, same facts, no invented prose", async () => {
  await setGenerativeAI(false);
  const panel = await ask(`What happened with ${companyName}?`);

  // The answer is still worth reading: the deal, its value and the recent conversation.
  await expect(panel.getByRole("region", { name: "From your CRM" })).toContainText(dealName);
  await expect(panel.getByRole("region", { name: "Sources" })).toContainText(companyName);
  await expect(panel.getByText(/retrieved directly from your CRM/i)).toBeVisible();
  // No written analysis, and no apology masquerading as an answer.
  await expect(panel.getByRole("region", { name: "Keel's analysis" })).toHaveCount(0);
  await expect(panel).not.toContainText(/^AI unavailable\.?$/);
  await expect(panel.getByText("Knowledge search mode").first()).toBeVisible();
});

test("6. restoring AI resumes normal mode", async () => {
  await setGenerativeAI(true);
  const panel = await ask(`What happened with ${companyName}?`);
  await expect(panel.getByRole("region", { name: "Keel's analysis" })).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/retrieved directly from your CRM/i)).toHaveCount(0);
});

test("7. a follow-up question knows what it is about", async () => {
  const panel = await ask(`Tell me about ${companyName}`);
  await panel.getByPlaceholder("Ask another question…").fill("What should I do next?");
  await panel.getByRole("button", { name: "Ask" }).click();
  await expect(panel.getByRole("region", { name: "Sources" }).last()).toContainText(
    new RegExp(`${companyName}|${dealName}`),
    { timeout: 60_000 },
  );
});
