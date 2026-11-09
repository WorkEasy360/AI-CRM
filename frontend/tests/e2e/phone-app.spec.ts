import { expect, test, type Browser, type Page } from "@playwright/test";
import { apiFromPage, login, RUN_ID, users } from "./helpers";

/**
 * The phone screens the Android app shows, end to end against real APIs: the welcome screen, the green
 * top bar, Home, Leads, Pipeline and Tasks with the bottom tabs, and that everything the phone layout
 * moved out of sight (search, sign-out, the full pages) can still be reached.
 */
const U = users();
const PHONE = { width: 390, height: 844 };
const name = (label: string) => `${label} ${RUN_ID}`;

let page: Page;

async function phone(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  return context.newPage();
}

test.beforeEach(async ({ browser }) => {
  page = await phone(browser);
  await login(page, U.owner, U.password);
});

test.afterEach(async () => {
  await page.context().close();
});

const tabs = () => page.getByRole("navigation", { name: "Quick navigation" });

test("the welcome screen leads to the form, and to sign-up", async ({ browser }) => {
  const fresh = await phone(browser);
  await fresh.goto("/login");
  const welcome = fresh.getByRole("region", { name: "Welcome to WorkEasy360 CRM" });
  await expect(welcome.getByRole("heading", { name: /Simple CRM for/ })).toBeVisible();
  await expect(welcome.getByRole("link", { name: "Create Account" })).toHaveAttribute("href", "/signup");
  await welcome.getByRole("button", { name: "Login to CRM" }).click();
  await expect(welcome).toBeHidden();
  await expect(fresh.getByRole("button", { name: "Log In to CRM" })).toBeVisible();

  // A failed single sign-on comes back with a message for the form: it must not be covered up.
  await fresh.goto("/login?sso_error=denied");
  await expect(fresh.getByRole("region", { name: "Welcome to WorkEasy360 CRM" })).toBeHidden();
  await fresh.context().close();
});

test("larger screens never see the welcome screen or the phone tabs", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const desktop = await context.newPage();
  await desktop.goto("/login");
  await expect(desktop.getByRole("region", { name: "Welcome to WorkEasy360 CRM" })).toBeHidden();
  await expect(desktop.getByRole("button", { name: "Log In to CRM" })).toBeVisible();
  await context.close();
});

test("the bottom tabs reach every screen, with its top bar and no sideways scroll", async () => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /^Hello/, level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Key figures" }).getByRole("link", { name: /Total Leads/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Sales Pipeline (Deals)" })).toBeVisible();

  for (const [tab, title, path] of [
    ["Leads", "Leads", "/contacts"],
    ["Pipeline", "Pipeline", "/pipeline"],
    ["Tasks", "Tasks & Follow-ups", "/activities"],
  ] as const) {
    await tabs().getByRole("link", { name: tab }).click();
    await page.waitForURL(`**${path}`);
    await expect(page.locator("header").getByText(title, { exact: true })).toBeVisible();
    await expect(tabs().getByRole("link", { name: tab })).toHaveAttribute("aria-current", "page");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} overflows sideways`).toBeLessThanOrEqual(0);
  }

  await page.getByRole("link", { name: "Back to Home" }).click();
  await page.waitForURL("**/dashboard");
  await page.getByRole("link", { name: "View full dashboard" }).click();
  await expect(page.getByRole("heading", { name: /^Welcome/, level: 1 })).toBeVisible();
});

test("Leads: the status tabs and search filter the list, and a lead can be called", async () => {
  const lead = await apiFromPage(page, "POST", "/api/v1/contacts/", { first_name: "Phone", last_name: name("Lead"), phone: "+919876500001" });
  expect(lead.status).toBe(201);
  const customer = await apiFromPage(page, "POST", "/api/v1/contacts/", { first_name: "Phone", last_name: name("Customer"), phone: "+919876500002", lifecycle_stage: "customer" });
  expect(customer.status).toBe(201);

  await page.goto("/contacts");
  await page.getByRole("textbox", { name: "Search leads" }).fill(RUN_ID);
  const row = (text: string) => page.getByRole("listitem").filter({ hasText: name(text) });
  await expect(row("Lead")).toBeVisible();
  await expect(row("Customer")).toBeVisible();
  await expect(row("Lead").getByRole("link", { name: /^Call / })).toHaveAttribute("href", "tel:+919876500001");

  await page.getByRole("button", { name: /^Converted/ }).click();
  await expect(row("Customer")).toBeVisible();
  await expect(row("Lead")).toBeHidden();
  await page.getByRole("button", { name: /^Active/ }).click();
  await expect(row("Lead")).toBeVisible();
  await expect(row("Customer")).toBeHidden();

  await page.getByRole("link", { name: "More filters and views" }).click();
  await page.waitForURL("**/contacts?tab=people*");
  await expect(page.getByRole("heading", { name: "Contacts", level: 1 })).toBeVisible();
});

test("Tasks: a task shows under its day, its contact can be called, and ticking it completes it", async () => {
  const contact = await apiFromPage(page, "POST", "/api/v1/contacts/", { first_name: "Task", last_name: name("Person"), phone: "+919876500003" });
  const contactId = (contact.body as { id: string }).id;
  const inAnHour = new Date(Date.now() + 3_600_000);
  // Keep it on today's date late in the evening, when an hour from now would be tomorrow.
  const today = inAnHour.getDate() === new Date().getDate() ? inAnHour : new Date();
  const created = await apiFromPage(page, "POST", "/api/v1/activities/", { kind: "task", title: name("Today task"), start_at: today.toISOString(), contact_id: contactId });
  expect(created.status).toBe(201);
  const later = await apiFromPage(page, "POST", "/api/v1/activities/", { kind: "task", title: name("Later task"), start_at: new Date(Date.now() + 3 * 86_400_000).toISOString() });
  expect(later.status).toBe(201);

  await page.goto("/activities");
  const row = page.getByRole("listitem").filter({ hasText: name("Today task") });
  await expect(row).toBeVisible();
  await expect(row.getByRole("link", { name: /^Call / })).toHaveAttribute("href", "tel:+919876500003");
  await expect(page.getByRole("listitem").filter({ hasText: name("Later task") })).toBeHidden();

  await page.getByRole("button", { name: /^Upcoming/ }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name("Later task") })).toBeVisible();
  await expect(row).toBeHidden();

  await page.getByRole("button", { name: /^Today/ }).click();
  await row.getByRole("checkbox", { name: /^Mark .* done$/ }).click();
  await expect(row).toBeHidden();

  await page.getByRole("button", { name: "Add a task" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("Pipeline: the board shows two stages, and the views behind Filters stay reachable", async () => {
  await page.goto("/pipeline");
  await expect(page.getByRole("tab", { name: "Kanban" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "List" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Forecast" })).toBeHidden();
  const columns = page.locator('[data-testid^="column-"]');
  const width = await columns.first().evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeLessThan(PHONE.width / 2);
  await expect(page.getByRole("heading", { name: "Pipeline", level: 1 })).toBeAttached();

  await page.getByRole("button", { name: "New deal" }).click();
  await expect(page.getByRole("dialog", { name: "Create Deal" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByRole("tab", { name: "Forecast" })).toBeVisible();
  await page.getByRole("tab", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/tab=analytics/);
});

test("More holds the full menu, search and sign-out", async () => {
  await page.goto("/dashboard");
  await tabs().getByRole("button", { name: "More" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Settings" })).toBeVisible();
  await drawer.getByRole("button", { name: "Search" }).click();
  await expect(page.locator("input[aria-label='Search']")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open navigation" }).click();
  const menu = page.getByRole("dialog", { name: "Navigation" });
  await menu.getByRole("button", { name: /account|user|profile|Olivia/i }).first().click();
  await expect(page.getByRole("menuitem", { name: /sign out|log out/i })).toBeVisible();
});
