import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantProvider } from "@/components/assistant/ask-keel";
import { AssistantPage } from "@/components/assistant/assistant-page";
import type { AssistantAnswer } from "@/lib/api/crm-types";
import type { DashboardSummary, Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  askKeel: vi.fn(),
  getAssistantHome: vi.fn(),
  deleteAssistantConversation: vi.fn(),
  activitySummary: vi.fn(),
  getMyDay: vi.fn(),
  completeActivity: vi.fn(),
}));
vi.mock("@/lib/api/endpoints", () => ({ getSession: vi.fn(), getDashboard: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/assistant", useSearchParams: () => new URLSearchParams() }));

import { activitySummary, askKeel, getAssistantHome, getMyDay } from "@/lib/api/crm";
import { getDashboard, getSession } from "@/lib/api/endpoints";

const session = {
  user: { id: "u1", email: "manoj@example.com", display_name: "Manoj Kumar" },
  active: {
    membership_id: "m1",
    organization: { id: "o1", name: "Acme", base_currency: "INR" },
    role: { key: "owner", name: "Owner" },
    permissions: { "ai.assistant.use": "all", "dashboards.view": "all", "activities.view": "all", "activities.create": "all", "deals.view": "all", "automation.view": "all" },
    mfa_required: false,
  },
} as unknown as Session;

const answer = {
  conversation_id: "c1",
  question: "Show my deal forecast for the next three months.",
  intent: "forecast",
  mode: "ai",
  answer_type: "summary",
  headline: "₹62,80,000 is expected to close in three months.",
  facts: [],
  analysis: "",
  recommendation: "",
  sections: [],
  sources: [],
  suggestions: [],
} as unknown as AssistantAnswer;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssistantProvider>
        <AssistantPage />
      </AssistantProvider>
    </QueryClientProvider>,
  );
}

describe("AssistantPage", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getAssistantHome).mockResolvedValue({ suggestions: [], generative_available: true, knowledge_available: true, recent: [{ id: "t1", title: "Follow-up message for Apex", last_message_at: new Date().toISOString() }] });
    vi.mocked(getDashboard).mockResolvedValue({
      contacts_created: 24,
      deals_created: 8,
      deals_won: { count: 2, amount: "350000.00" },
      previous: { since: "", deals_created: 7, deals_won: { count: 1, amount: "300000.00" }, win_rate: 30 },
      insights: [{ key: "deals_close_to_winning", count: 2, amount: "1200000.00" }],
    } as unknown as DashboardSummary);
    vi.mocked(activitySummary).mockResolvedValue({ overdue: 0, due_today: 3, open_tasks: 5, meetings_week: 1, calls_week: 2, follow_ups: 6 });
    vi.mocked(getMyDay).mockResolvedValue({
      date: "2026-11-05",
      timezone: "UTC",
      overdue: [],
      tasks: [],
      events: [],
      calls: [{ id: "a1", kind: "call", title: "Follow up with Apex Technologies", status: "open", start_at: "2026-11-05T06:00:00Z", version: 1 } as never],
      no_date: [],
      completed_today: 0,
    });
    vi.mocked(askKeel).mockReset().mockResolvedValue(answer);
  });

  it("shows the header, this week's summary, today's follow-ups and the AI suggestion", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: /WorkEasy AI Assistant/ })).toBeInTheDocument();
    expect(screen.getByText("Powered by AI")).toBeInTheDocument();
    expect(await screen.findByText("Here's your CRM summary for this week, Manoj:")).toBeInTheDocument();
    const week = screen.getByRole("list", { name: "This week" });
    expect(await within(week).findByText("24")).toBeInTheDocument();
    expect(within(week).getByText("₹3,50,000")).toBeInTheDocument();
    expect(await within(week).findByText("6")).toBeInTheDocument(); // pending follow-ups
    expect(await screen.findByText("Follow up with Apex Technologies")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Call/ })).toHaveAttribute("href", "/activities?open=a1");
    expect(await screen.findByRole("link", { name: /View Leads/ })).toBeInTheDocument();
    expect(screen.getByText("Follow-up message for Apex")).toBeInTheDocument(); // recent AI actions
  });

  it("answers inline from a suggestion chip, without opening the side panel", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Show deal forecast" }));
    await waitFor(() => expect(askKeel).toHaveBeenCalledWith({ question: "Show my deal forecast for the next three months.", conversation_id: null }));
    const conversation = screen.getByRole("region", { name: "Conversation" });
    expect(await within(conversation).findByText("₹62,80,000 is expected to close in three months.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers the eight quick actions, with reports and automation as real pages", async () => {
    renderPage();
    const actions = await screen.findByRole("region", { name: "AI Quick Actions" });
    for (const name of [/Write Message/, /Create Task/, /Schedule Meeting/, /Generate Proposal/, /Summarize Lead/, /More Tools/]) {
      expect(within(actions).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(actions).getByRole("link", { name: /Create Automation/ })).toHaveAttribute("href", "/settings/automation");
    expect(within(actions).getByRole("link", { name: /Get Reports/ })).toHaveAttribute("href", "/pipeline?tab=analytics");
  });
});
