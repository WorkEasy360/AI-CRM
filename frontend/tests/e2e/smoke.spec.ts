import { expect, test } from "@playwright/test";

/**
 * Smoke test against a running frontend (production standalone server in CI, or the dev server
 * proxying to Django locally). Skipped unless E2E_BASE_URL is set.
 *
 * "forgot-password page hydrates" needs no backend and is the guard for the CSP/nonce contract:
 * a page prerendered at build time ships nonce-less scripts that `strict-dynamic` blocks, and the
 * form never appears. There is no sign-in or sign-up page: the CRM opens directly.
 */
test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set; skipping smoke test");

test("forgot-password page hydrates under the production CSP (no blocked scripts)", async ({ page }) => {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/.test(message.text())) blocked.push(message.text().slice(0, 160));
  });
  await page.goto("/forgot-password");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
  // Typing proves React hydrated: a prerendered, script-less page would not keep the value in state.
  await page.getByLabel("Email").fill("smoke@example.com");
  await expect(page.getByLabel("Email")).toHaveValue("smoke@example.com");
  expect(blocked, "scripts blocked by CSP").toEqual([]);
});

test("security headers are present", async ({ request }) => {
  const response = await request.get("/forgot-password");
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
});
