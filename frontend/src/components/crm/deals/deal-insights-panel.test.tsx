import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DealInsightsPanel } from "@/components/crm/deals/deal-insights-panel";
import { ToastProvider } from "@/components/ui/toast";
import type { Deal, DealInsights } from "@/lib/api/crm-types";
import type { RoleRef, Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  generateFollowUp: vi.fn(),
}));

vi.mock("@/components/messaging/email-composer-dialog", () => ({
  EmailComposerDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Email composer" /> : null),
}));

let permissions: Record<string, "own" | "team" | "all"> = { "ai.scores.view": "all", "ai.copilot.use": "all" };
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  const session = (): Session => ({
    user: { id: "u1", email: "ada@example.com", display_name: "Ada" } as Session["user"],
    mfa_enabled: false,
    recently_authenticated: true,
    memberships: [],
    active: {
      membership_id: "m1",
      organization: { id: "o1", name: "Keel", slug: "keel", base_currency: "USD", timezone: "UTC", plan: "free", status: "active", require_mfa: false, created_at: "2026-01-01T00:00:00Z" },
      role: { key: "sales_rep", name: "Sales Rep" } as RoleRef,
      permissions,
      mfa_required: false,
    },
  });
  return { ...actual, useSession: () => ({ data: session() }) };
});

import { generateFollowUp } from "@/lib/api/crm";

const deal: Deal = {
  id: "d1",
  name: "Acme renewal",
  owner: { id: "m1", display_name: "Ada" },
  tags: [],
  custom_data: {},
  version: 1,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  pipeline: { id: "p1", name: "Sales" },
  stage: { id: "s1", name: "Proposal", kind: "open", color_token: "teal" },
  company: { id: "c1", name: "Acme" },
  primary_contact: { id: "k1", name: "Hank Scorpio", email: "hank@acme.test" },
  amount: "12000.00",
  currency: "USD",
  exchange_rate: "1",
  amount_base: "12000.00",
  probability: 50,
  expected_close_date: "2026-09-30",
  status: "open",
  closed_at: null,
  lost_reason: "",
  stage_entered_at: "2026-09-01T00:00:00Z",
  description: "",
  line_count: 0,
  probability_overridden: false,
  weighted_amount_base: "6000.00",
  last_activity_at: "2026-08-20T00:00:00Z",
  next_activity_at: null,
  next_activity_title: "",
  risk_level: "high",
  contact_count: 1,
  products_total: null,
};

const insights: DealInsights = {
  computed_at: "2026-09-13T08:00:00Z",
  risk: {
    level: "high",
    score: 78,
    label: "Rules-based risk",
    reasons: ["No activity for 24 days", "No next step scheduled"],
    recommended_action: "Schedule a call this week.",
    signals: [
      { signal: "inactivity", weight: 40, days: 24 },
      { signal: "no_next_activity", weight: 25 },
    ],
  },
  next_best_action: { action: "Call Hank about the proposal", reason: "The proposal went out 10 days ago with no reply.", evidence: ["Email sent 10 days ago", "No inbound since"], kind: "call", confidence: "high" },
  lead_score: { value: 72, label: "Rules-based", reasons: ["Decision maker", "Replied within a day"] },
  communication: { last_outbound_at: "2026-09-03T10:00:00Z", last_inbound_at: null },
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DealInsightsPanel deal={deal} insights={insights} isPending={false} contact={{ id: "k1", name: "Hank Scorpio", email: "hank@acme.test" }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("DealInsightsPanel", () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    permissions = { "ai.scores.view": "all", "ai.copilot.use": "all" };
    vi.mocked(generateFollowUp).mockReset();
  });

  it("renders risk reasons, signals, the next best action with evidence and the lead score", () => {
    renderPanel();

    expect(screen.getByText("High risk")).toBeInTheDocument();
    const reasons = screen.getByRole("list", { name: "Risk reasons" });
    expect(within(reasons).getByText("No activity for 24 days")).toBeInTheDocument();
    expect(within(reasons).getByText("No next step scheduled")).toBeInTheDocument();
    expect(screen.getByText("Schedule a call this week.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Risk signals" })).getByText(/Inactivity/)).toBeInTheDocument();

    expect(screen.getByText("Call Hank about the proposal")).toBeInTheDocument();
    expect(screen.getByText("high confidence")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Evidence" })).getByText("Email sent 10 days ago")).toBeInTheDocument();

    expect(screen.getByText("72/100")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Lead score reasons" })).getByText("Decision maker")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("generates a follow-up draft with the chosen tone and channel, and never sends it", async () => {
    const user = userEvent.setup();
    vi.mocked(generateFollowUp).mockResolvedValue({ draft: "Hi Hank, following up on the proposal…", style: "professional", channel: "email", sources: ["1 email"], flagged_input: true });
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Generate follow-up" }));
    const dialog = await screen.findByRole("dialog", { name: "Generate follow-up" });
    expect(generateFollowUp).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "WhatsApp" }));
    await user.click(within(dialog).getByRole("button", { name: "Generate draft" }));
    await waitFor(() => expect(generateFollowUp).toHaveBeenCalledWith({ entity_type: "deal", entity_id: "d1", tone: "professional", channel: "whatsapp" }));

    const draft = await within(dialog).findByLabelText("Draft (editable)");
    expect(draft).toHaveValue("Hi Hank, following up on the proposal…");
    expect(within(dialog).getByText(/flagged and left out/)).toBeInTheDocument();
    // WhatsApp drafts are copied by hand; "Use in email" only appears for the email channel.
    expect(within(dialog).queryByRole("button", { name: "Use in email" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Email" }));
    expect(within(dialog).getByRole("button", { name: "Use in email" })).toBeEnabled();

    await user.clear(draft);
    await user.type(draft, "Edited by hand");
    expect(draft).toHaveValue("Edited by hand");
  });

  it("hides the scores without ai.scores.view but keeps the next best action", () => {
    permissions = { "ai.copilot.use": "all" };
    renderPanel();
    expect(screen.queryByRole("list", { name: "Risk reasons" })).not.toBeInTheDocument();
    expect(screen.queryByText("72/100")).not.toBeInTheDocument();
    expect(screen.getByText("Call Hank about the proposal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate follow-up" })).toBeInTheDocument();
  });
});
