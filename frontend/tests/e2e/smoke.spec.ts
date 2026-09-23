import { expect, test } from "@playwright/test";

/**
 * Smoke test against a running frontend (production standalone server in CI, or the dev server
 * proxying to Django locally). Skipped unless E2E_BASE_URL is set.
 *
 * "login page hydrates" needs no backend and is the guard for the CSP/nonce contract: a page
 * prerendered at build time ships nonce-less scripts that `strict-dynamic` blocks, and the form
 * never appears. The signup test needs Django behind the proxy (E2E_USERS_FILE marks a full stack);
 * email verification cannot be completed here, so it stops at the "check your email" screen.
 */
test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set; skipping smoke test");

test("login page hydrates under the production CSP (no blocked scripts)", async ({ page }) => {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/.test(message.text())) blocked.push(message.text().slice(0, 160));
  });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  // Typing proves React hydrated: a prerendered, script-less page would not keep the value in state.
  await page.getByLabel("Email").fill("smoke@example.com");
  await expect(page.getByLabel("Email")).toHaveValue("smoke@example.com");
  expect(blocked, "scripts blocked by CSP").toEqual([]);
});

test("signup asks for name, email and password only, then stops at the check-your-email screen", async ({ page }) => {
  test.skip(!process.env.E2E_USERS_FILE, "needs Django behind the proxy");
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto("/signup");
  await expect(page.getByLabel(/organization/i)).toHaveCount(0);
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("signup-check-email")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
});

test("security headers are present", async ({ request }) => {
  const response = await request.get("/login");
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
});
