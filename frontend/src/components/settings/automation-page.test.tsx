import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationPage, summary } from "@/components/settings/automation-page";
import { ToastProvider } from "@/components/ui/toast";
import type { AutomationRule } from "@/lib/api/automation";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/automation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/automation")>();
  return { ...actual, listAutomationRules: vi.fn(), createAutomationRule: vi.fn(), updateAutomationRule: vi.fn(), deleteAutomationRule: vi.fn() };
});
vi.mock("@/lib/api/crm", () => ({ listWhatsAppTemplates: vi.fn() }));

const SESSION = {
  active: { membership_id: "m1", permissions: { "automation.view": "all", "automation.manage": "all", "whatsapp.view": "all" } },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { createAutomationRule, listAutomationRules } from "@/lib/api/automation";
import { listWhatsAppTemplates } from "@/lib/api/crm";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // Radix Select uses pointer capture and scrollIntoView, which jsdom does not implement.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: "r1",
    name: "Follow-up Reminder",
    description: "",
    trigger: "contact_created",
    stage_id: null,
    stage_name: null,
    action: "send_whatsapp",
    message: "",
    delay_days: 3,
    only_if_no_reply: true,
    whatsapp_template_id: "t1",
    whatsapp_template_name: "follow_up",
    template_params: ["{{first_name}}"],
    is_enabled: true,
    pending_runs: 2,
    last_outcome: "skipped",
    last_detail: "The contact replied.",
    run_count: 4,
    last_run_at: "2026-11-04T10:00:00Z",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AutomationPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("AutomationPage", () => {
  beforeEach(() => {
    vi.mocked(listAutomationRules).mockReset();
    vi.mocked(createAutomationRule).mockReset();
    vi.mocked(listWhatsAppTemplates).mockReset().mockResolvedValue({
      next: null,
      previous: null,
      results: [{ id: "t1", name: "welcome_lead", language: "en", category: "MARKETING", body: "Hi {{1}}, welcome!", parameter_count: 1, status: "approved", created_at: "" }],
    });
  });

  it("describes waiting and skipped WhatsApp runs", async () => {
    vi.mocked(listAutomationRules).mockResolvedValue([rule()]);
    renderPage();
    expect(await screen.findByText("Follow-up Reminder")).toBeInTheDocument();
    expect(screen.getByText("When a new lead is added: if there is no reply in 3 days, send a WhatsApp message.")).toBeInTheDocument();
    expect(screen.getByText(/2 waiting/)).toBeInTheDocument();
    expect(screen.getByText("Last run skipped: The contact replied.")).toBeInTheDocument();
  });

  it("opens the editor for a WhatsApp starter rule and saves the chosen template", async () => {
    const user = userEvent.setup();
    vi.mocked(listAutomationRules).mockResolvedValue([]);
    vi.mocked(createAutomationRule).mockResolvedValue(rule({ name: "New Lead Welcome" }));
    renderPage();
    await user.click(await screen.findByRole("button", { name: /New Lead Welcome/ }));
    expect(createAutomationRule).not.toHaveBeenCalled(); // a template has to be chosen first

    await user.click(await screen.findByRole("combobox", { name: "WhatsApp template" }));
    await user.click(await screen.findByRole("option", { name: "welcome_lead (en)" }));
    expect(screen.getByLabelText("Value for {{1}}")).toHaveValue("{{first_name}}");
    expect(screen.getByText("Hi {{1}}, welcome!")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createAutomationRule).toHaveBeenCalled());
    expect(vi.mocked(createAutomationRule).mock.calls[0]?.[0]).toMatchObject({
      name: "New Lead Welcome (WhatsApp)",
      action: "send_whatsapp",
      whatsapp_template_id: "t1",
      template_params: ["{{first_name}}"],
      only_if_no_reply: false,
    });
  });

  it("creates a non-WhatsApp starter rule in one click", async () => {
    const user = userEvent.setup();
    vi.mocked(listAutomationRules).mockResolvedValue([]);
    vi.mocked(createAutomationRule).mockResolvedValue(rule({ name: "Deal Won Notification", action: "notify_team" }));
    renderPage();
    await user.click(await screen.findByRole("button", { name: /Deal Won Notification/ }));
    await waitFor(() =>
      expect(createAutomationRule).toHaveBeenCalledWith(expect.objectContaining({ action: "notify_team", trigger: "deal_won", description: "Notify team on deal won." })),
    );
  });
});

describe("summary", () => {
  it("reads the rule back in plain words", () => {
    expect(summary({ trigger: "contact_created", action: "create_task", delay_days: 2, only_if_no_reply: false })).toBe("When a new lead is added, create a task due in 2 days.");
    expect(summary({ trigger: "deal_won", action: "send_whatsapp", delay_days: 0, only_if_no_reply: false })).toBe("When a deal is won, send a WhatsApp message.");
    expect(summary({ trigger: "deal_created", action: "notify_owner", delay_days: 1, only_if_no_reply: false })).toBe("When a deal is created, notify the owner after 1 day.");
    expect(summary({ trigger: "deal_stage_entered", stage_name: "Proposal", action: "send_whatsapp", delay_days: 3, only_if_no_reply: true })).toBe(
      "When a deal enters Proposal: if there is no reply in 3 days, send a WhatsApp message.",
    );
  });
});
