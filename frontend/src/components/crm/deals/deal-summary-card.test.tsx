import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DealSummaryCard } from "@/components/crm/deals/deal-summary-card";
import type { DealSummary } from "@/lib/api/crm-types";
import { ApiError } from "@/lib/api/problem";
import type { RoleRef, Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  summarizeDeal: vi.fn(),
}));

let permissions: Record<string, "own" | "team" | "all"> = { "ai.copilot.use": "all" };
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

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: session() }) };
});

import { summarizeDeal } from "@/lib/api/crm";

const summary: DealSummary = {
  headline: "Acme renewal is close to signature.",
  value: "$12,000 over 12 months",
  recent_activity: "Pricing call on Monday; proposal sent.",
  customer_concern: "Onboarding timeline.",
  next_action: "Confirm the start date with Hank.",
  expected_close: "End of this month.",
  risks: ["No reply since the proposal", "Legal review pending"],
  sources: ["3 notes", "2 emails"],
  flagged_input: false,
  label: "AI-generated",
  cached: false,
};

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DealSummaryCard dealId="d1" />
    </QueryClientProvider>,
  );
}

describe("DealSummaryCard", () => {
  beforeEach(() => {
    permissions = { "ai.copilot.use": "all" };
    vi.mocked(summarizeDeal).mockReset();
  });

  it("only summarizes on demand and renders every section", async () => {
    const user = userEvent.setup();
    vi.mocked(summarizeDeal).mockResolvedValue(summary);
    renderCard();

    expect(summarizeDeal).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Summarize with AI" }));
    await waitFor(() => expect(summarizeDeal).toHaveBeenCalledWith("d1", false));

    expect(await screen.findByText("Acme renewal is close to signature.")).toBeInTheDocument();
    for (const label of ["Value", "Recent activity", "Customer concern", "Next action", "Expected close", "Risks"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("$12,000 over 12 months")).toBeInTheDocument();
    expect(screen.getByText("Confirm the start date with Hank.")).toBeInTheDocument();
    expect(screen.getByText("Legal review pending")).toBeInTheDocument();
    expect(screen.getByText("AI-generated")).toBeInTheDocument();
    expect(screen.getByText(/Based on: 3 notes, 2 emails/)).toBeInTheDocument();

    // Refresh forces a new summary and shows the cached/flagged markers from the response.
    vi.mocked(summarizeDeal).mockResolvedValue({ ...summary, cached: true, flagged_input: true });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(summarizeDeal).toHaveBeenLastCalledWith("d1", true));
    expect(await screen.findByText("Cached")).toBeInTheDocument();
    expect(screen.getByText(/flagged and left out/)).toBeInTheDocument();
  });

  it("explains a quota error in plain words", async () => {
    const user = userEvent.setup();
    vi.mocked(summarizeDeal).mockRejectedValue(new ApiError({ type: "quota_exceeded", title: "Too many requests", status: 429 }));
    renderCard();

    await user.click(screen.getByRole("button", { name: "Summarize with AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The AI quota is used up for now. Try again in a little while.");
    expect(screen.getByRole("button", { name: "Summarize with AI" })).toBeEnabled();
  });

  it("renders nothing without ai.copilot.use", () => {
    permissions = {};
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });
});
