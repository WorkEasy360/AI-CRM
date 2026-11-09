import { expect, test, type Browser, type Page } from "@playwright/test";
import { RUN_ID, apiFromPage, dialog, users } from "./helpers";

/**
 * The redesigned sign-in, Pipeline and Dashboard screens, end to end against real APIs:
 * Remember me sets the cookie's lifetime; cards call, message and plan; filters and period narrow the
 * board; every dashboard figure opens its records; ticking a task completes it.
 */

const U = users();
const name = (label: string) => `${label} ${RUN_ID}`;
const SESSION_COOKIE = "keel_session";

async function signIn(browser: Browser, remember: boolean) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  // The development auto-login may already have opened a session; only a signed-out browser shows the form.
  await expect(page.getByRole("heading", { name: "CRM Login" })).toBeVisible();
  await page.getByLabel("Email Address").fill(U.owner);
  await page.getByLabel("Password", { exact: true }).fill(U.password);
  if (remember) await page.getByRole("checkbox", { name: "Remember me" }).check();
  await page.getByRole("button", { name: "Log In to CRM" }).click();
  await page.waitForURL(/\/pipeline/, { waitUntil: "commit" });
  await expect(page.getByRole("heading", { name: "Pipeline", level: 1 })).toBeVisible();
  return { context, page };
}

test.describe.configure({ mode: "serial" });
test.skip(!process.env.E2E_USERS_FILE, "needs Django behind the proxy");

let page: Page;
let contactId = "";
let pipelineId = "";
let openDealId = "";

test("the login page offers the design's controls and links", async ({ page: p }) => {
  await p.goto("/login");
  await expect(p.getByRole("heading", { name: "CRM Login" })).toBeVisible();
  await expect(p.getByRole("link", { name: "Forgot Password?" })).toHaveAttribute("href", "/forgot-password");
  await expect(p.getByRole("link", { name: "Create CRM Account" })).toHaveAttribute("href", "/signup");
  await p.getByLabel("Password", { exact: true }).fill("secret");
  await p.getByRole("button", { name: "Show password" }).click();
  await expect(p.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
});

test("Remember me decides whether the session outlives the browser", async ({ browser }) => {
  const forgot = await signIn(browser, false);
  const session = (await forgot.context.cookies()).find((c) => c.name === SESSION_COOKIE);
  expect(session?.expires, "a browser-session cookie has no expiry").toBe(-1);
  await forgot.context.close();

  const kept = await signIn(browser, true);
  const lasting = (await kept.context.cookies()).find((c) => c.name === SESSION_COOKIE);
  expect(lasting?.expires ?? 0).toBeGreaterThan(Date.now() / 1000 + 86_400);
  page = kept.page;
});

test("prepare records through the API", async () => {
  const pipelines = await apiFromPage(page, "GET", "/api/v1/pipelines/");
  const list = (pipelines.body as { results: { id: string; is_default: boolean }[] }).results;
  pipelineId = (list.find((p) => p.is_default) ?? list[0])!.id;
  const contact = await apiFromPage(page, "POST", "/api/v1/contacts/", { first_name: "Card", last_name: RUN_ID, phone: "+919876500001" });
  expect(contact.status).toBe(201);
  contactId = (contact.body as { id: string }).id;
  const deal = await apiFromPage(page, "POST", "/api/v1/deals/", { name: name("Open deal"), pipeline_id: pipelineId, amount: "1000", primary_contact_id: contactId });
  expect(deal.status).toBe(201);
  openDealId = (deal.body as { id: string }).id;
});

test("a deal card calls, messages and plans a follow-up", async () => {
  await page.goto(`/pipeline?pipeline=${pipelineId}`);
  const card = page.getByTestId(`deal-card-${openDealId}`);
  await expect(card.getByRole("link", { name: `Call Card ${RUN_ID}` })).toHaveAttribute("href", "tel:+919876500001");
  await expect(card.getByText("No next step")).toBeVisible();

  await card.getByRole("button", { name: `WhatsApp Card ${RUN_ID}` }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await card.getByRole("button", { name: `Add a follow-up for ${name("Open deal")}` }).click();
  const form = page.getByRole("dialog");
  await expect(form.getByLabel(/title/i).first()).toHaveValue(`Follow up: ${name("Open deal")}`);
  await form.getByRole("button", { name: /create|save/i }).first().click();
  await expect(form).toBeHidden();
  await expect(card.getByText("No next step")).toBeHidden({ timeout: 15_000 });
});

test("the period keeps open deals, and Filters reveals search", async () => {
  // A deal won this month is shown; open deals stay whatever the period.
  const pipelines = await apiFromPage(page, "GET", `/api/v1/pipelines/${pipelineId}/`);
  const stages = (pipelines.body as { stages: { id: string; kind: string }[] }).stages;
  const won = await apiFromPage(page, "POST", "/api/v1/deals/", { name: name("Won deal"), pipeline_id: pipelineId, amount: "500", stage_id: stages.find((s) => s.kind === "won")!.id });
  expect(won.status).toBe(201);

  await page.goto(`/pipeline?pipeline=${pipelineId}`);
  const summary = page.getByRole("region", { name: "Pipeline summary" });
  await expect(summary.getByText("Open Pipeline Value")).toBeVisible();
  await expect(summary.getByText("Conversion Rate")).toBeVisible();
  await expect(page.getByText(name("Won deal"))).toBeVisible();
  await expect(page.getByTestId(`deal-card-${openDealId}`)).toBeVisible();

  await page.getByRole("combobox", { name: "Period for won and lost deals" }).click();
  await page.getByRole("option", { name: "Last Month" }).click();
  await expect(page.getByText(name("Won deal"))).toBeHidden();
  await expect(page.getByTestId(`deal-card-${openDealId}`)).toBeVisible();

  await expect(page.getByRole("textbox", { name: "Search deals" })).toBeHidden();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("textbox", { name: "Search deals" }).fill("no-such-deal-xyz");
  await expect(page.getByTestId(`deal-card-${openDealId}`)).toBeHidden();
});

test("the dashboard's figures open their records and a ticked task completes", async () => {
  const task = await apiFromPage(page, "POST", "/api/v1/activities/", { kind: "task", title: name("Pending task"), start_at: new Date(Date.now() - 86_400_000).toISOString() });
  expect(task.status).toBe(201);

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Records" })).toHaveText(/My Records/);
  const kpis = page.getByRole("region", { name: "Key figures" });
  await expect(kpis.getByRole("link", { name: /Total Leads/ })).toHaveAttribute("href", "/contacts");

  const row = page.getByRole("region", { name: "Pending Tasks" }).getByRole("listitem").filter({ hasText: name("Pending task") });
  await expect(row.getByText("Overdue")).toBeVisible();
  await row.getByRole("checkbox").click();
  await expect(page.getByRole("region", { name: "Pending Tasks" }).getByText(name("Pending task"))).toBeHidden({ timeout: 15_000 });

  await page.getByRole("combobox", { name: "Records" }).click();
  await page.getByRole("option", { name: "All Records" }).click();
  await expect(page).toHaveURL(/owner=all/);

  await page.getByRole("region", { name: "Quick Actions" }).getByRole("button", { name: "Add Lead" }).click();
  await expect(dialog(page, "New contact")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("region", { name: "Leads by Status" }).getByRole("link", { name: /^Lead/ }).click();
  await expect(page).toHaveURL(/\/contacts\?lifecycle=lead/);
});

test("no screen scrolls sideways on a phone", async ({ browser }) => {
  const state = await page.context().storageState();
  const phone = await browser.newContext({ viewport: { width: 360, height: 780 }, storageState: state });
  const p = await phone.newPage();
  for (const path of ["/pipeline", "/dashboard"]) {
    await p.goto(path);
    await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    await p.waitForLoadState("networkidle");
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} must not scroll sideways`).toBeLessThanOrEqual(0);
  }
  await phone.close();
});
