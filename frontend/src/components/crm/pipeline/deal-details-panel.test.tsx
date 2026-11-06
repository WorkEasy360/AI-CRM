import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DealDetailsPanel } from "@/components/crm/pipeline/deal-details-panel";
import { PipelineAnalyticsView } from "@/components/crm/pipeline/pipeline-analytics";
import { ToastProvider } from "@/components/ui/toast";
import type { Deal } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  getDeal: vi.fn(),
  updateDeal: vi.fn(),
  moveDealStage: vi.fn(),
  dealLines: vi.fn(async () => ({ results: [{ id: "l1", product: { id: "p1", name: "WorkEasy360 CRM" } }] })),
  listRecordActivities: vi.fn(async () => ({
    next: null,
    previous: null,
    results: [
      { id: "a1", title: "Follow up call completed", status: "completed", start_at: "2026-11-05T06:00:00Z" },
      { id: "a2", title: "Send proposal", status: "open", start_at: "2026-11-05T09:30:00Z" },
    ],
  })),
  listNotes: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listFiles: vi.fn(async () => ({ next: null, previous: null, results: [] })),
}));
vi.mock("@/lib/api/pipeline-analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/pipeline-analytics")>();
  return { ...actual, getPipelineAnalytics: vi.fn() };
});
vi.mock("@/lib/api/endpoints", () => ({ listMembers: vi.fn(async () => ({ next: null, previous: null, results: [] })) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/pipeline", useSearchParams: () => new URLSearchParams() }));

let permissions: Record<string, string> = {};
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: { active: { membership_id: "m1", organization: { base_currency: "INR" }, permissions } } as unknown as Session }) };
});

import { getDeal, moveDealStage, updateDeal } from "@/lib/api/crm";
import { getPipelineAnalytics } from "@/lib/api/pipeline-analytics";

const STAGES = [
  { id: "s1", name: "New Lead", kind: "open" as const },
  { id: "s2", name: "Qualified", kind: "open" as const },
  { id: "won", name: "Won", kind: "won" as const },
];

const DEAL = {
  id: "d1",
  name: "CRM for Real Estate",
  version: 3,
  stage: { id: "s1", name: "New Lead", kind: "open" },
  pipeline: { id: "p1", name: "Sales Pipeline" },
  company: { id: "c1", name: "Apex Builders" },
  primary_contact: null,
  owner: { id: "m1", display_name: "Manoj Kumar" },
  amount: "500000.00",
  currency: "INR",
  amount_from_lines: false,
  expected_close_date: "2026-11-10",
  status: "open",
  lead_source: "facebook_ads",
  priority: "high",
  line_count: 1,
} as unknown as Deal;

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe("DealDetailsPanel", () => {
  beforeEach(() => {
    permissions = { "deals.view": "all", "deals.update": "all", "deals.change_stage": "all", "activities.view": "all", "notes.view": "all", "files.view": "all" };
    vi.mocked(getDeal).mockResolvedValue(DEAL);
    vi.mocked(moveDealStage).mockResolvedValue({ ...DEAL, stage: { id: "s2", name: "Qualified", kind: "open" } } as Deal);
    vi.mocked(updateDeal).mockResolvedValue({ ...DEAL, lead_source: "referral" } as Deal);
  });

  it("shows the facts and activities, and moves the deal to the next stage", async () => {
    const user = userEvent.setup();
    wrap(<DealDetailsPanel dealId="d1" stages={STAGES} onClose={() => {}} />);
    const panel = await screen.findByRole("region", { name: "Deal Details" });
    expect(within(panel).getByText("CRM for Real Estate")).toBeInTheDocument();
    expect(within(panel).getByText("Apex Builders")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Edit deal value" })).toHaveTextContent("₹5,00,000");
    expect(await within(panel).findByText("WorkEasy360 CRM")).toBeInTheDocument();
    expect(await within(panel).findByText("Follow up call completed")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Completed")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: /Move to Next Stage/ }));
    await waitFor(() => expect(moveDealStage).toHaveBeenCalledWith("d1", 3, "s2", undefined));
  });

  it("is read-only without update rights", async () => {
    permissions = { "deals.view": "all" };
    wrap(<DealDetailsPanel dealId="d1" stages={STAGES} onClose={() => {}} />);
    const panel = await screen.findByRole("region", { name: "Deal Details" });
    expect(within(panel).queryByRole("button", { name: /Move to Next Stage/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Edit deal value" })).not.toBeInTheDocument();
    expect(within(panel).getByText("Facebook Ads")).toBeInTheDocument();
  });
});

describe("PipelineAnalyticsView", () => {
  it("renders conversion, win/loss, sources and owners", async () => {
    vi.mocked(getPipelineAnalytics).mockResolvedValue({
      pipeline: { id: "p1", name: "Sales" },
      conversion: [
        { id: "s1", name: "New Lead", kind: "open", color_token: "blue", reached: 10, current: 4, rate: 100 },
        { id: "s2", name: "Qualified", kind: "open", color_token: "green", reached: 5, current: 2, rate: 50 },
      ],
      win_loss: { won: 3, lost: 1, open: 6, win_rate: 75, won_amount: "1200000.00", lost_amount: "100000.00", lost_reasons: [{ reason: "Budget", count: 1 }] },
      sources: [{ source: "whatsapp", label: "WhatsApp", count: 6, won: 2, won_amount: "800000.00" }],
      owners: [{ id: "m1", name: "Manoj", deals: 7, won: 3, win_rate: 75, won_amount: "1200000.00" }],
    });
    wrap(<PipelineAnalyticsView pipelineId="p1" filters={{}} baseCurrency="INR" />);
    const conversion = await screen.findByRole("region", { name: "Conversion by stage" });
    expect(within(conversion).getByText("Qualified")).toBeInTheDocument();
    expect(within(conversion).getByText("· 50%")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Win / loss" })).getByText("75%")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Deals by source" })).getByText("WhatsApp")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Owner performance" })).getByText("₹12,00,000")).toBeInTheDocument();
  });
});
