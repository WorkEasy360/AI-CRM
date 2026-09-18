import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { login, RUN_ID, users } from "./helpers";

/**
 * User management, password reset and the Integration Hub against a live stack.
 * Emails are read from Mailpit (E2E_MAILPIT_URL, default http://localhost:8025), where the backend's
 * SMTP delivery lands in development.
 */

const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";

test.skip(!process.env.E2E_BASE_URL, "Set E2E_BASE_URL to run against a live stack.");

async function linkFromMail(request: APIRequestContext, to: string, pattern: RegExp): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages = [] } = (await search.json()) as { messages?: Array<{ ID: string }> };
    for (const message of messages) {
      const detail = (await (await request.get(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as { Text?: string };
      const match = detail.Text?.match(pattern);
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No email matching ${pattern} for ${to}`);
}

/** Fill after hydration: a dev-mode first compile can replace the input right after the first keystrokes. */
async function fillEmail(page: Page, email: string): Promise<void> {
  const input = page.getByLabel("Email");
  await expect(async () => {
    await input.fill(email);
    await expect(input).toHaveValue(email, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

async function confirmPasswordIfAsked(page: Page, password: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  if (await dialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await dialog.getByLabel("Password").fill(password);
    await dialog.getByRole("button", { name: "Confirm" }).click();
  }
}

test("admin invites a user who sets their own password and lands in the CRM", async ({ page, browser, request }) => {
  const { owner, password } = users();
  const invitee = `invitee-${RUN_ID}@e2e.keel.test`;
  const inviteeName = `Priya ${RUN_ID}`;

  await login(page, owner, password);
  await page.goto("/settings/users");
  await expect(page.getByRole("heading", { name: "Users & Teams" })).toBeVisible();
  await page.getByRole("button", { name: "Invite user" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite user" });
  await dialog.getByLabel("Name").fill(inviteeName);
  await dialog.getByLabel("Email").fill(invitee);
  await dialog.getByLabel("Role").click();
  await page.getByRole("option", { name: "Sales Representative" }).click();
  await expect(dialog.getByLabel(/password/i)).toHaveCount(0); // admins never set someone else's password
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("row", { name: new RegExp(inviteeName) })).toContainText("Invited");

  const acceptUrl = await linkFromMail(request, invitee, /https?:\/\/\S+\/invitations\/accept\?token=[\w-]+/);
  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();
  await inviteePage.goto(acceptUrl);
  await expect(inviteePage.getByRole("heading", { name: /^Join / })).toBeVisible();
  await expect(inviteePage.getByLabel("Name")).toHaveValue(inviteeName);
  await inviteePage.getByLabel("Password", { exact: true }).fill("short");
  await inviteePage.getByLabel("Confirm password").fill("short");
  await inviteePage.getByRole("button", { name: "Create account and join" }).click();
  await expect(inviteePage.getByText("Use at least 12 characters.")).toBeVisible();

  const newPassword = `Invitee-${RUN_ID}-Str0ng!`;
  await inviteePage.getByLabel("Password", { exact: true }).fill(newPassword);
  await inviteePage.getByLabel("Confirm password").fill(newPassword);
  await inviteePage.getByRole("button", { name: "Create account and join" }).click();
  await inviteePage.waitForURL(/\/pipeline/, { timeout: 30_000 });
  await expect(inviteePage.getByRole("navigation", { name: "Primary" })).toBeVisible();

  // the link is single use
  await inviteePage.context().clearCookies();
  await inviteePage.goto(acceptUrl);
  await expect(inviteePage.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  await inviteeContext.close();

  await page.reload();
  await expect(page.getByRole("row", { name: new RegExp(inviteeName) })).toContainText("Active");
});

test("forgot password gives a generic answer, resets securely and signs in", async ({ page, request }) => {
  test.setTimeout(180_000); // the reset route may compile on first use in dev mode
  const { rep, password } = users();

  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.waitForURL(/\/forgot-password/);
  await fillEmail(page, `nobody-${RUN_ID}@e2e.keel.test`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  const generic = "If an account exists for this email, password reset instructions have been sent.";
  await expect(page.getByText(generic)).toBeVisible();

  await page.goto("/forgot-password");
  await fillEmail(page, rep);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(generic)).toBeVisible();

  const resetUrl = await linkFromMail(request, rep, /https?:\/\/\S+\/reset-password\/[^\s]+/);
  await page.goto(resetUrl);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible({ timeout: 90_000 });
  await page.getByLabel("New password", { exact: true }).fill("mismatch-one-1234");
  await page.getByLabel("Confirm new password").fill("mismatch-two-1234");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();

  // Restore the shared seed password so other suites keep working.
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("heading", { name: "Password updated" })).toBeVisible();

  // the link cannot be used twice
  await page.goto(resetUrl);
  await page.getByLabel("New password", { exact: true }).fill(`Another-${RUN_ID}-Pass!`);
  await page.getByLabel("Confirm new password").fill(`Another-${RUN_ID}-Pass!`);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("heading", { name: "Password updated" })).toHaveCount(0);

  await login(page, rep, password);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});

test("integration hub: scoped API key works only where it is allowed", async ({ page, request }) => {
  const { owner, rep, password } = users();

  // sales users never see integrations
  await login(page, rep, password);
  await page.goto("/settings");
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Integrations" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Integrations" })).toHaveCount(0);
  await page.context().clearCookies();

  await login(page, owner, password);
  await page.goto("/settings/integrations");
  await expect(page.getByText("Google Workspace").first()).toBeVisible();
  await expect(page.getByText("Generic REST API").first()).toBeVisible();

  await page.goto("/settings/integrations/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByLabel("Name").fill(`E2E reader ${RUN_ID}`);
  await dialog.getByRole("checkbox", { name: "Read contacts" }).check();
  await dialog.getByRole("button", { name: "Create key" }).click();
  await confirmPasswordIfAsked(page, password);

  const reveal = page.getByRole("dialog", { name: /API key .* created/ });
  await expect(reveal).toBeVisible();
  const key = ((await reveal.locator("[data-secret-value]").first().textContent()) ?? "").trim();
  expect(key).toMatch(/^keel_[0-9a-f]{16}_[\w-]{43}$/);
  await reveal.getByRole("button", { name: "I have saved it" }).click();
  await expect(page.getByText(key)).toHaveCount(0); // never shown again

  const auth = { Authorization: `Bearer ${key}` };
  expect((await request.get("/api/v1/contacts/", { headers: auth })).status()).toBe(200);
  expect((await request.post("/api/v1/contacts/", { headers: auth, data: { first_name: "Nope" } })).status()).toBe(403);
  expect((await request.get("/api/v1/companies/", { headers: auth })).status()).toBe(403);
  expect((await request.get("/api/v1/session/", { headers: auth })).status()).toBe(403);
  expect((await request.get("/api/v1/members/", { headers: auth })).status()).toBe(403);

  await page.getByRole("button", { name: `Revoke E2E reader ${RUN_ID}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Revoke/ }).click();
  await expect.poll(async () => (await request.get("/api/v1/contacts/", { headers: auth })).status()).toBe(401);
});

test("webhooks refuse internal destinations", async ({ page }) => {
  const { owner, password } = users();
  await login(page, owner, password);
  await page.goto("/settings/integrations/webhooks");
  await page.getByRole("button", { name: /Add webhook/ }).click();
  const dialog = page.getByRole("dialog", { name: /Add webhook/ });
  await dialog.getByLabel("Name").fill("Metadata probe");
  await dialog.getByLabel(/URL/).fill("https://169.254.169.254/latest/meta-data/");
  await dialog.getByRole("checkbox").first().check();
  await dialog.getByRole("button", { name: /Add webhook|Create/ }).click();
  await confirmPasswordIfAsked(page, password);
  await expect(page.getByText(/private network|not allowed|Internal addresses/i).first()).toBeVisible();
  await expect(page.getByText(/whsec_/)).toHaveCount(0);
});
