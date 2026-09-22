import { expect, test, type Browser, type Page } from "@playwright/test";
import { ALLAUTH, RUN_ID, apiFromPage, dialog, login, signOut, totp, users } from "./helpers";

/**
 * Browser behaviour that unit tests cannot cover: server-side session loss, MFA enrolment + login,
 * permission denial in the UI and the API, concurrent edits of one deal, loading/error states,
 * phone/tablet layouts and keyboard-only operation. Runs against the live stack (helpers.ts).
 */
const HAVE_STACK = Boolean(process.env.E2E_BASE_URL && process.env.E2E_USERS_FILE);
test.skip(!HAVE_STACK, "E2E_BASE_URL / E2E_USERS_FILE not set; skipping browser behaviour suite");

const U = HAVE_STACK ? users() : ({} as ReturnType<typeof users>);
const dealName = `Concurrency deal ${RUN_ID}`;
let dealUrl = "";

async function ownerPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, U.owner, U.password);
  return page;
}

test.beforeAll(async ({ browser }) => {
  const page = await ownerPage(browser);
  await page.goto("/pipeline");
  await page.getByRole("button", { name: "Deal" }).click();
  const d = dialog(page, "Create Deal");
  await d.getByLabel("Deal name").fill(dealName);
  await d.getByLabel("Amount").fill("1200");
  await d.getByRole("button", { name: "Create deal" }).click();
  await expect(d).toBeHidden();
  await page.getByRole("link", { name: dealName }).click();
  await page.waitForURL(/\/deals\//);
  dealUrl = page.url();
  await page.context().close();
});

test("session expiry: a session revoked server-side stops rendering the CRM", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await login(a, U.rep, U.password);
  await a.goto("/contacts");
  await expect(a.getByRole("heading", { name: "Contacts" })).toBeVisible();

  const b = await (await browser.newContext()).newPage();
  await login(b, U.rep, U.password);
  await b.goto("/settings/security");
  await b.getByRole("button", { name: "Sign out other sessions" }).click();
  await expect(b.getByRole("button", { name: "Sign out other sessions" })).toBeDisabled({ timeout: 15_000 });

  // There is no sign-in page to bounce to, so the gate shows its retryable message instead.
  await a.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Companies" }).click();
  await expect(a.getByText("We couldn't load your session")).toBeVisible({ timeout: 20_000 });
  await expect(a.getByRole("heading", { name: "Contacts" })).toHaveCount(0);
  await a.context().close();
  await b.context().close();
});

test("MFA: enrol a TOTP authenticator, re-authenticate with a code, then disable it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await login(page, U.mfa, U.password);
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.locator("code").first().textContent())?.replace(/\s+/g, "") ?? "";
  expect(secret.length).toBeGreaterThan(15);
  await page.getByLabel("Confirmation code").fill(totp(secret));
  await page.getByRole("button", { name: "Enable two-factor" }).click();
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible({ timeout: 15_000 });

  await signOut(page);
  // The password alone must not be enough: allauth answers 401 with the second factor pending.
  const passwordOnly = await apiFromPage(page, "POST", `${ALLAUTH}/auth/login`, { email: U.mfa, password: U.password });
  expect(passwordOnly.status).toBe(401);
  const wrongCode = await apiFromPage(page, "POST", `${ALLAUTH}/auth/2fa/authenticate`, { code: "000000" });
  expect(wrongCode.status).toBe(400);
  const rightCode = await apiFromPage(page, "POST", `${ALLAUTH}/auth/2fa/authenticate`, { code: totp(secret) });
  expect(rightCode.status).toBe(200);
  await page.goto("/pipeline");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Disable two-factor" }).click();
  await dialog(page, "Disable two-factor authentication?").getByRole("button", { name: "Disable", exact: true }).click();
  await expect(page.getByText("Not enabled", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.context().close();
});

test("permission denial: a viewer gets read-only UI, no admin pages, and 403s from the API", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await login(page, U.viewer, U.password);
  await page.goto(dealUrl);
  await expect(page.getByRole("heading", { name: dealName })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move to…" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Quick actions" })).toHaveCount(0);

  await page.goto("/pipeline");
  // Wait for the shell before asserting anything is absent. `toHaveCount(0)` is satisfied by a page
  // that has not rendered yet, so without this these checks can pass against the loading skeleton and
  // never look at the real UI - which is exactly what hid the Settings entry below until the session
  // started resolving during HTML parsing rather than after hydration.
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deal" })).toHaveCount(0);

  // Settings is not an admin area: every member has one (their own notifications and security), and
  // the nav inside it is what is filtered by permission. A viewer reaches it and finds nothing
  // administrative there.
  await page.goto("/settings");
  const settingsNav = page.getByRole("navigation", { name: "Settings" });
  await expect(settingsNav.getByRole("link", { name: "Security" })).toHaveCount(1);
  await expect(settingsNav.getByRole("link", { name: /General|Users & Teams|Pipelines|Custom fields|Audit log|Import \/ Export/ })).toHaveCount(0);

  // The member directory is readable by every role (names and roles of colleagues); a viewer gets
  // no invite / role / disable actions and the write endpoints refuse.
  await page.goto("/settings/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Invite/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Change role|Disable/ })).toHaveCount(0);
  const invited = await apiFromPage(page, "POST", "/api/v1/invitations/", { email: `mallory-${RUN_ID}@example.com`, role_key: "sales_rep" });
  expect(invited.status).toBe(403);

  const created = await apiFromPage(page, "POST", "/api/v1/contacts/", { first_name: "Mallory", last_name: RUN_ID });
  expect(created.status).toBe(403);
  const moved = await apiFromPage(page, "POST", `/api/v1/deals/${dealUrl.split("/deals/")[1]}/stage/`, { stage_id: "00000000-0000-0000-0000-000000000000" });
  expect(moved.status).toBe(403);
  const usage = await apiFromPage(page, "GET", "/api/v1/ai/usage/");
  expect(usage.status).toBe(403);
  await page.context().close();
});

test("concurrent edits: the second writer is told the deal changed and nothing is silently overwritten", async ({ browser }) => {
  const a = await ownerPage(browser);
  const b = await ownerPage(browser);
  await a.goto(dealUrl);
  await b.goto(dealUrl);
  await a.getByRole("button", { name: "Edit", exact: true }).click();
  await b.getByRole("button", { name: "Edit", exact: true }).click();
  const da = dialog(a, "Edit Deal");
  const db = dialog(b, "Edit Deal");
  await da.getByLabel("Deal name").fill(`${dealName} (renamed by A)`);
  await da.getByRole("button", { name: "Save changes" }).click();
  await expect(da).toBeHidden();
  await expect(a.getByRole("heading", { name: `${dealName} (renamed by A)` })).toBeVisible();

  await db.getByLabel("Amount").fill("9999");
  await db.getByRole("button", { name: "Save changes" }).click();
  await expect(db.getByText(/Someone else changed this deal/)).toBeVisible();
  await db.getByRole("button", { name: "Cancel" }).click();
  await b.reload();
  await expect(b.getByRole("heading", { name: `${dealName} (renamed by A)` })).toBeVisible();
  await expect(b.getByText("9,999")).toHaveCount(0);
  await a.context().close();
  await b.context().close();
});

test("loading and error states: the board shows a skeleton while loading and a retryable error on failure", async ({ browser }) => {
  const page = await ownerPage(browser);
  await page.route("**/api/v1/deals/board/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });
  await page.goto("/pipeline");
  await expect(page.getByRole("status", { name: "Loading board" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Pipeline stages" })).toBeVisible({ timeout: 20_000 });
  await page.unroute("**/api/v1/deals/board/**");

  await page.route("**/api/v1/deals/board/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503 }) }),
  );
  await page.reload();
  await expect(page.getByText("Could not load the board")).toBeVisible();
  await page.unroute("**/api/v1/deals/board/**");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("list", { name: "Pipeline stages" })).toBeVisible({ timeout: 20_000 });

  await page.goto("/deals/00000000-0000-0000-0000-000000000000");
  await expect(page.getByText(/not found|could not|no longer/i).first()).toBeVisible();
  await page.context().close();
});

for (const device of [
  { name: "phone", viewport: { width: 390, height: 844 }, isMobile: true, collapsedActions: true },
  { name: "tablet", viewport: { width: 820, height: 1180 }, isMobile: true, collapsedActions: false },
]) {
  test(`${device.name} layout: bottom navigation, drawer menu, quick actions, no horizontal scroll`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: true });
    const page = await context.newPage();
    await login(page, U.owner, U.password);
    await page.goto("/pipeline");
    await expect(page.getByRole("navigation", { name: "Quick navigation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto(dealUrl);
    const actions = page.getByRole("group", { name: "Quick actions" });
    if (device.collapsedActions) {
      // Below the small breakpoint the tail of the action bar collapses into "More".
      await expect(actions.getByRole("button", { name: "More actions" })).toBeVisible();
      await expect(actions.getByRole("button", { name: "Meeting" })).toBeHidden();
      await actions.getByRole("button", { name: "More actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Meeting" })).toBeVisible();
      await page.keyboard.press("Escape");
    } else {
      await expect(actions.getByRole("button", { name: "Meeting" })).toBeVisible();
      await expect(actions.getByRole("button", { name: "More actions" })).toBeHidden();
    }

    for (const path of ["/pipeline", dealUrl, "/dashboard", "/contacts"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
    }
    await context.close();
  });
}

test("keyboard navigation: open search with Ctrl+K, drive the quick-add menu and dialogs without a mouse", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await login(page, U.owner, U.password);

  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "Search" });
  await expect(search).toBeVisible();
  await expect(search.locator("input[aria-label='Search']")).toBeFocused();
  await page.keyboard.type("Concurrency");
  await expect(search.getByRole("listbox", { name: "Search results" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();

  await page.getByRole("button", { name: "New record" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const created = page.getByRole("dialog");
  await expect(created).toBeVisible();
  await expect(created.getByRole("textbox").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(created).toBeHidden();
  await expect(page.getByRole("button", { name: "New record" })).toBeFocused();

  // Fresh page: tabbing reaches the interactive shell (the first Tab after navigation may still be
  // consumed by the browser chrome in headless mode, so allow a couple of presses).
  await page.goto("/pipeline");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  let focused = "";
  for (let i = 0; i < 3 && !["A", "BUTTON", "INPUT"].includes(focused); i++) {
    await page.keyboard.press("Tab");
    focused = (await page.evaluate(() => document.activeElement?.tagName)) ?? "";
  }
  expect(["A", "BUTTON", "INPUT"]).toContain(focused);
  await page.context().close();
});
