import { defineConfig } from "@playwright/test";

/**
 * E2E smoke tests run only when E2E_BASE_URL points at a running stack
 * (Next.js dev server proxying to Django). CI does not set it, so the spec
 * skips itself; see tests/e2e/smoke.spec.ts.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
});
