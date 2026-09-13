import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Shared helpers for the browser E2E suites. They run only against a live stack:
 *   E2E_BASE_URL            Next.js origin proxying to Django (e.g. http://localhost:3100)
 *   E2E_USERS_FILE          JSON written by the seed script: {password, owner, viewer, rep, mfa}
 *   E2E_WHATSAPP_APP_SECRET the WHATSAPP_APP_SECRET the backend was started with (webhook signing)
 * The backend must run with MESSAGING_PROVIDER_BACKEND=fake; AI may be fake or a real provider.
 */

export interface E2EUsers {
  password: string;
  owner: string;
  viewer: string;
  rep: string;
  mfa: string;
}

export function users(): E2EUsers {
  const file = process.env.E2E_USERS_FILE;
  if (!file) throw new Error("E2E_USERS_FILE is not set");
  return JSON.parse(readFileSync(file, "utf8")) as E2EUsers;
}

export const RUN_ID = Date.now().toString(36);

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
}

/** Pick an option in a Radix select whose trigger carries the given accessible name. */
export async function pickSelect(scope: Page | Locator, trigger: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name: trigger }).click();
  const page = "page" in scope ? scope.page() : scope;
  await page.getByRole("option", { name: option }).click();
}

export function dialog(page: Page, name: string | RegExp): Locator {
  return page.getByRole("dialog", { name });
}

/** Stat tile (dashboard/forecast) located by its label. */
export function tile(page: Page, label: string): Locator {
  return page.locator("section[aria-label] > *").filter({ has: page.getByText(label, { exact: true }) }).first();
}

/** The tile's value paragraph (tabular figures); absent while the tile still shows its skeleton. */
export function tileValue(page: Page, label: string): Locator {
  return tile(page, label).locator("p.tabular-nums").first();
}

export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible({ timeout: 15_000 });
}

/* ------------------------------------------------------------------ TOTP (RFC 6238) */

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

/* ------------------------------------------------------------------ WhatsApp webhook */

export async function postWhatsAppWebhook(
  request: APIRequestContext,
  baseURL: string,
  payload: unknown,
  secret = process.env.E2E_WHATSAPP_APP_SECRET ?? "",
): Promise<number> {
  const raw = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const res = await request.post(`${baseURL}/api/v1/whatsapp/webhook/`, {
    data: raw,
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
  });
  return res.status();
}

export function inboundTextEvent(phoneNumberId: string, from: string, body: string, id = `wamid.e2e.${Date.now()}`) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "e2e",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550100", phone_number_id: phoneNumberId },
              messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ CSRF-aware fetch from the page */

export async function apiFromPage(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie
        .split("; ")
        .find((c) => c.startsWith("keel_csrftoken="))
        ?.split("=")[1];
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRFToken": decodeURIComponent(csrf) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    },
    { method, path, body },
  );
}
