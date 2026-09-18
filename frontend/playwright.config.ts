import { defineConfig } from "@playwright/test";

/**
 * Browser E2E suites run only when E2E_BASE_URL points at a live stack (Next.js proxying to Django
 * started with MESSAGING_PROVIDER_BACKEND=fake; see tests/e2e/helpers.ts for the other variables).
 * CI does not set it, so every spec skips itself. Specs are deterministic and share seeded users, so
 * they run one worker at a time.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4000",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
