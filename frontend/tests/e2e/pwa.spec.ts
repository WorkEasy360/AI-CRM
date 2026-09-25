import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Installable web app + Android Trusted Web Activity contract, against a production server (the CI
 * standalone smoke step; no backend needed). Skipped unless E2E_BASE_URL is set.
 *
 * - the manifest and icons the Android app is generated from are served and valid, and Chrome itself
 *   reports the page as installable;
 * - the service worker only ever holds the offline page: no CRM/API response is cached, and a failed
 *   navigation shows the offline page instead of Chrome's error;
 * - /.well-known/assetlinks.json names the same package as android/twa-manifest.json, so the
 *   Android app opens verified (full screen) and handles the site's links.
 */
test.skip(!process.env.E2E_BASE_URL, "E2E_BASE_URL not set; skipping PWA checks");

const twaManifest = JSON.parse(readFileSync(path.join(__dirname, "../../../android/twa-manifest.json"), "utf8")) as {
  packageId: string;
  startUrl: string;
};

test("manifest and icons are served and complete", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = (await response.json()) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
  expect(manifest).toMatchObject({ name: "Keel CRM", short_name: "Keel", scope: "/", display: "standalone" });
  expect(manifest.start_url).toBe(twaManifest.startUrl);
  const has = (sizes: string, purpose: string) => manifest.icons.some((i) => i.sizes === sizes && i.purpose === purpose);
  expect(has("192x192", "any") && has("512x512", "any") && has("512x512", "maskable")).toBe(true);
  for (const icon of manifest.icons) {
    const res = await request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
  }
});

test("Chrome reports the app as installable", async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  expect(installabilityErrors).toEqual([]);
});

test("the service worker caches only the offline page, and shows it when the network is gone", async ({ page, context }) => {
  await page.goto("/login");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(new URL("/", page.url()).href);
  // Take control of this page (the first load happens before the worker claims it), then make API
  // traffic of the kind the CRM makes.
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.evaluate(() => Promise.allSettled([fetch("/api/v1/session/"), fetch("/_allauth/browser/v1/config")]));

  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
    }
    return urls;
  });
  expect(cached).toEqual(["/offline.html"]);

  await context.setOffline(true);
  await page.goto("/pipeline").catch(() => undefined);
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await context.setOffline(false);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("Digital Asset Links name the Android app's package", async ({ request }) => {
  const response = await request.get("/.well-known/assetlinks.json", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  const statements = (await response.json()) as {
    relation: string[];
    target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
  }[];
  const app = statements.find((s) => s.target.namespace === "android_app" && s.target.package_name === twaManifest.packageId);
  expect(app?.relation).toContain("delegate_permission/common.handle_all_urls");
  expect(app?.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
  for (const fingerprint of app?.target.sha256_cert_fingerprints ?? []) expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});
