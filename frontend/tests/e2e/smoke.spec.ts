import { expect, test } from "@playwright/test";

/**
 * Smoke test against a running stack (Next.js dev server proxying to Django).
 * Skipped unless E2E_BASE_URL is set, so CI does not need a backend.
 * Email verification cannot be completed here (no mailbox access), so the
 * signup flow stops at the "check your email" screen.
 */
test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set; skipping smoke test");

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("signup stops at the check-your-email screen", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery-staple");
  await page.getByLabel("Confirm password").fill("correct-horse-battery-staple");
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
