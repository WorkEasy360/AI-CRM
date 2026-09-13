import { expect, test, type Page } from "@playwright/test";
import { RUN_ID, dialog, expectToast, inboundTextEvent, login, pickSelect, postWhatsAppWebhook, tileValue, users } from "./helpers";

/**
 * The critical business workflow, driven through the browser against a live stack (see helpers.ts):
 * login -> pipeline -> company -> contact -> deal -> stage move -> task -> meeting -> call -> email
 * -> WhatsApp (template, inbound reply, free text) -> AI summary / follow-up / risk -> closed won
 * -> dashboard + forecast. One page, in order; every step leaves state the next one relies on.
 */
const HAVE_STACK = Boolean(process.env.E2E_BASE_URL && process.env.E2E_USERS_FILE);
test.skip(!HAVE_STACK, "E2E_BASE_URL / E2E_USERS_FILE not set; skipping browser workflow");
test.describe.configure({ mode: "serial" });

const U = HAVE_STACK ? users() : ({} as ReturnType<typeof users>);
const company = `Globex ${RUN_ID}`;
const contact = { first: "Hank", last: `Scorpio ${RUN_ID}`, email: `hank-${RUN_ID}@globex.example`, phone: `+1 555 0100 ${String(Date.now()).slice(-3)}` };
const contactDigits = contact.phone.replace(/\D+/g, "");
const deal = { name: `Globex reactor ${RUN_ID}`, amount: "5000" };
const phoneNumberId = String(Date.now()); // Meta phone number ids are digits only

let page: Page;
let dealUrl = "";
let activePhoneNumberId = phoneNumberId;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test("1. login lands in the CRM", async () => {
  await login(page, U.owner, U.password);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});

test("2. pipeline board shows the default stages", async () => {
  await page.goto("/pipeline");
  const stages = page.getByRole("list", { name: "Pipeline stages" });
  await expect(stages).toBeVisible();
  for (const name of ["Qualification", "Needs analysis", "Proposal", "Negotiation", "Closed won", "Closed lost"]) {
    await expect(page.getByRole("list", { name: `${name} deals` })).toBeVisible();
  }
});

test("3. create a company", async () => {
  await page.goto("/companies");
  await page.getByRole("button", { name: "Company" }).click();
  const d = dialog(page, "New company");
  await d.getByLabel("Name").fill(company);
  await d.getByRole("button", { name: "Create company" }).click();
  await expect(d).toBeHidden();
  await expect(page.getByText(company).first()).toBeVisible();
});

test("4. create a contact linked to the company, with WhatsApp consent", async () => {
  await page.goto("/contacts");
  await page.getByRole("button", { name: "Contact" }).click();
  const d = dialog(page, "New contact");
  await d.getByLabel("First name").fill(contact.first);
  await d.getByLabel("Last name").fill(contact.last);
  await d.getByLabel("Email").fill(contact.email);
  await d.getByLabel("Phone").fill(contact.phone);
  await pickSelect(d, "Company", company);
  await d.getByRole("button", { name: /More details/ }).click();
  await d.getByLabel("Contact agreed to receive WhatsApp messages").check();
  await d.getByRole("button", { name: "Create contact" }).click();
  await expect(d).toBeHidden();
  await expect(page.getByText(`${contact.first} ${contact.last}`).first()).toBeVisible();
});

test("5. create a deal and see it on the board", async () => {
  await page.goto("/pipeline");
  await page.getByRole("button", { name: "Deal" }).click();
  const d = dialog(page, "New deal");
  await d.getByLabel("Deal name").fill(deal.name);
  await pickSelect(d, "Company", company);
  await pickSelect(d, "Primary contact", `${contact.first} ${contact.last}`);
  await d.getByLabel("Amount").fill(deal.amount);
  await d.getByRole("button", { name: "Create deal" }).click();
  await expect(d).toBeHidden();
  const card = page.getByRole("list", { name: "Qualification deals" }).getByText(deal.name);
  await expect(card).toBeVisible();
});

test("6. move the deal to the next stage from the board", async () => {
  await page.getByRole("button", { name: `Move ${deal.name} to another stage` }).click();
  await page.getByRole("menuitem", { name: "Needs analysis" }).click();
  await expect(page.getByRole("list", { name: "Needs analysis deals" }).getByText(deal.name)).toBeVisible();
  await expect(page.getByRole("list", { name: "Qualification deals" }).getByText(deal.name)).toHaveCount(0);
});

test("7. open the deal; the header offers WhatsApp for the primary contact", async () => {
  await page.getByRole("link", { name: deal.name }).click();
  await page.waitForURL(/\/deals\//);
  dealUrl = page.url();
  const actions = page.getByRole("group", { name: "Quick actions" });
  await expect(actions.getByRole("button", { name: "WhatsApp" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Email" })).toBeVisible();
});

test("8. create a task", async () => {
  await page.getByRole("group", { name: "Quick actions" }).getByRole("button", { name: "Task" }).click();
  const d = dialog(page, "New task");
  await d.getByLabel("Title").fill(`Send pricing ${RUN_ID}`);
  await d.getByRole("button", { name: "Create task" }).click();
  await expect(d).toBeHidden();
  await expectToast(page, "Task created");
});

test("9. schedule a meeting", async () => {
  await page.getByRole("group", { name: "Quick actions" }).getByRole("button", { name: "Meeting" }).click();
  const d = dialog(page, "Schedule meeting");
  await d.getByLabel("Title").fill(`Discovery ${RUN_ID}`);
  const start = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  const local = `${start.toISOString().slice(0, 10)}T10:00`;
  await d.getByLabel("Starts").fill(local);
  await d.getByRole("button", { name: "Schedule meeting" }).click();
  await expect(d).toBeHidden();
  await expectToast(page, "Meeting scheduled");
});

test("10. log a call", async () => {
  await page.getByRole("group", { name: "Quick actions" }).getByRole("button", { name: "Call" }).click();
  const d = dialog(page, "Log call");
  await d.getByLabel("Title").fill(`Intro call ${RUN_ID}`);
  await d.getByRole("button", { name: "Log call" }).click();
  await expect(d).toBeHidden();
  await expectToast(page, "Call logged");
});

test("11. connect a mailbox (sandbox OAuth) and send an email from the deal", async ({ baseURL }) => {
  await page.goto("/settings/email");
  // The fake provider's authorization URL is off-box; finish the OAuth dance by bouncing the browser
  // straight to the callback with the state the backend issued.
  await page.route("https://fake.example/**", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state") ?? "";
    await route.fulfill({ status: 302, headers: { location: `${baseURL}/api/v1/email/accounts/callback/?state=${state}&code=e2e-owner-${RUN_ID}` } });
  });
  await page.getByRole("button", { name: /^Connect (Gmail|Google)/ }).click();
  await page.waitForURL(/\/settings\/email/);
  await expect(page.getByText(`e2e-owner-${RUN_ID}@example.com`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
  await page.unroute("https://fake.example/**");

  await page.goto(dealUrl);
  await page.getByRole("group", { name: "Quick actions" }).getByRole("button", { name: "Email" }).click();
  const d = page.getByRole("dialog").filter({ has: page.getByLabel("Subject") });
  await expect(d.getByText(contact.email)).toBeVisible();
  await d.getByLabel("Subject").fill(`Proposal ${RUN_ID}`);
  await d.getByPlaceholder("Write in plain text. Line breaks are kept.").fill("Attached is our proposal. Let me know a good time to walk through it.");
  await d.getByRole("button", { name: "Send", exact: true }).click();
  await expect(d).toBeHidden();

  await page.getByRole("tab", { name: "Communication" }).click();
  const emails = page.getByRole("region", { name: "Emails" });
  await expect(emails.getByText(`Proposal ${RUN_ID}`)).toBeVisible();
  // The send runs on the worker; poll until the row reads "Sent".
  await expect
    .poll(
      async () => {
        await emails.getByRole("button", { name: "Refresh emails" }).click();
        return emails.getByText("Sent", { exact: true }).count();
      },
      { timeout: 30_000, intervals: [1000, 2000, 3000] },
    )
    .toBeGreaterThan(0);
});

test("12. connect WhatsApp (sandbox), add a template, send it from the deal header", async () => {
  await page.goto("/settings/whatsapp");
  // Account status is behind the admin throttle scope; repeated runs can hit it. Wait until the
  // status badge (not a throttle message) is on screen before deciding which branch to take.
  const badge = page.getByText(/^(Connected|Not connected)$/).first();
  for (let attempt = 0; attempt < 8 && !(await badge.isVisible()); attempt++) {
    await page.waitForTimeout(8_000);
    await page.reload();
  }
  await expect(badge).toBeVisible();
  if (await page.getByLabel("Phone number ID").count()) {
    await page.getByLabel("Phone number ID").fill(phoneNumberId);
    await page.getByLabel("Access token").fill(`e2e-token-${RUN_ID}`);
    await page.getByRole("button", { name: "Connect WhatsApp" }).click();
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    activePhoneNumberId = phoneNumberId;
  } else {
    // A previous run left the workspace connected: sign webhook events for that account instead.
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
    activePhoneNumberId = (await page.locator("dt:has-text('Phone number ID') + dd").textContent())?.trim() ?? "";
    expect(activePhoneNumberId).toMatch(/^\d+$/);
  }
  // The token is never rendered back.
  await expect(page.getByText(`e2e-token-${RUN_ID}`)).toHaveCount(0);

  await page.getByRole("button", { name: "Add template" }).click();
  const t = dialog(page, "Add message template");
  await t.getByLabel("Name").fill(`proposal_sent_${RUN_ID}`);
  await t.getByLabel("Body").fill("Hi {{1}}, we sent the proposal.");
  await t.getByRole("button", { name: "Add template" }).click();
  await expect(t).toBeHidden();
  await expect(page.getByText(`proposal_sent_${RUN_ID}`).first()).toBeVisible();

  await page.goto(dealUrl);
  await page.getByRole("group", { name: "Quick actions" }).getByRole("button", { name: "WhatsApp" }).click();
  const d = dialog(page, "WhatsApp message");
  await expect(d.getByText(contact.phone)).toBeVisible();
  // Several approved templates may exist from earlier runs; pick this run's explicitly.
  await pickSelect(d, "Template", new RegExp(`^proposal_sent_${RUN_ID}`));
  await d.getByLabel("Value for {{1}}").fill(contact.first);
  await d.getByRole("button", { name: "Send template" }).click();
  await expect(d).toBeHidden();

  await page.getByRole("tab", { name: "Communication" }).click();
  const conversation = page.getByRole("region", { name: "WhatsApp conversation" });
  await expect(conversation.getByText(`Hi ${contact.first}, we sent the proposal.`)).toBeVisible({ timeout: 15_000 });
});

test("13. an inbound WhatsApp reply (signed webhook) opens the service window for a free-text answer", async ({ request, baseURL }) => {
  const status = await postWhatsAppWebhook(request, baseURL!, inboundTextEvent(activePhoneNumberId, contactDigits, `Thanks, looks good! ${RUN_ID}`));
  expect(status).toBe(200);
  // A forged signature is rejected.
  expect(await postWhatsAppWebhook(request, baseURL!, inboundTextEvent(activePhoneNumberId, contactDigits, "forged"), "wrong-secret")).toBe(403);

  await page.reload();
  await page.getByRole("tab", { name: "Communication" }).click();
  const conversation = page.getByRole("region", { name: "WhatsApp conversation" });
  await expect(conversation.getByText(`Thanks, looks good! ${RUN_ID}`)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("group", { name: "Quick actions" }).getByRole("button", { name: "WhatsApp" }).click();
  const d = dialog(page, "WhatsApp message");
  await d.getByRole("textbox").last().fill(`Great, I will send the contract tomorrow. ${RUN_ID}`);
  await d.getByRole("button", { name: "Send", exact: true }).click();
  await expect(d).toBeHidden();
  await expect(conversation.getByText(`Great, I will send the contract tomorrow. ${RUN_ID}`)).toBeVisible({ timeout: 15_000 });
});

test("14. AI summary is generated on demand and labelled as a draft", async () => {
  await page.goto(dealUrl);
  await page.getByRole("button", { name: "Summarize with AI" }).click();
  const summary = page.getByRole("region", { name: "AI summary" });
  await expect(summary.getByText(/summary/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(summary.getByText("Next action", { exact: false })).toBeVisible();
  await expect(summary.getByText(/AI drafts can be wrong/)).toBeVisible();
});

test("15. AI follow-up draft and rules-based risk", async () => {
  await page.getByRole("tab", { name: "AI Insights" }).click();
  await expect(page.getByText(/Rules-based risk/).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Risk reasons" }).or(page.getByText(/score \d+/)).first()).toBeVisible();
  await page.getByRole("button", { name: "Generate follow-up" }).click();
  const d = dialog(page, "Generate follow-up");
  await d.getByRole("button", { name: "Generate draft" }).click();
  await expect(d.getByText(/[Your name]|follow/i).first()).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
});

/** Parse a formatted money/count tile value ("$5,000.00", "1,234") into a number. */
function numeric(text: string | null): number {
  return Number((text ?? "").replace(/[^0-9.]/g, "")) || 0;
}
const before = { won: 0, revenue: 0, calls: 0 };

test("16. close the deal as won", async () => {
  // Baseline the dashboard first: the seeded organization accumulates across runs.
  await page.goto("/dashboard");
  for (const label of ["Deals won", "Won revenue", "Calls"]) await expect(tileValue(page, label)).toBeVisible({ timeout: 20_000 });
  before.won = numeric(await tileValue(page, "Deals won").textContent());
  before.revenue = numeric(await tileValue(page, "Won revenue").textContent());
  before.calls = numeric(await tileValue(page, "Calls").textContent());

  await page.goto(dealUrl);
  await page.getByRole("button", { name: "Move to…" }).click();
  await page.getByRole("menuitem", { name: /Closed won/ }).click();
  await expect(page.getByText("Won on", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});

test("17. dashboard and forecast reflect the win", async () => {
  await page.goto("/dashboard");
  await expect(tileValue(page, "Deals won")).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => numeric(await tileValue(page, "Deals won").textContent()), { timeout: 30_000 }).toBe(before.won + 1);
  expect(numeric(await tileValue(page, "Won revenue").textContent())).toBeCloseTo(before.revenue + Number(deal.amount), 0);
  expect(numeric(await tileValue(page, "Calls").textContent())).toBeGreaterThanOrEqual(before.calls);
  await page.goto("/dashboard/forecast");
  await expect(tileValue(page, "Won so far")).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => numeric(await tileValue(page, "Won so far").textContent()), { timeout: 30_000 }).toBeGreaterThanOrEqual(Number(deal.amount));
});
