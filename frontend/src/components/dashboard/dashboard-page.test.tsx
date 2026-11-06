import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import type { Pipeline } from "@/lib/api/crm-types";
import type { DashboardSummary, Session } from "@/lib/api/types";

vi.mock("@/lib/api/endpoints", () => ({
  getSession: vi.fn(),
  getDashboard: vi.fn(),
}));

vi.mock("@/lib/api/crm", () => ({
  listPipelines: vi.fn(),
  // The dashboard now hosts Ask Keel; its calls are stubbed out so these tests stay about the numbers.
  getAssistantHome: vi.fn(),
  askKeel: vi.fn(),
  deleteAssistantConversation: vi.fn(),
  getMyDay: vi.fn(async () => ({ date: "2026-11-05", timezone: "UTC", overdue: [], tasks: [], events: [], calls: [], no_date: [], completed_today: 0 })),
  listActivities: vi.fn(async () => ({ next: null, previous: null, results: [] })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
}));

import { getAssistantHome, listPipelines } from "@/lib/api/crm";
import { getDashboard, getSession } from "@/lib/api/endpoints";

const organization = {
  id: "o1",
  name: "Acme",
  slug: "acme",
  base_currency: "USD",
  timezone: "UTC",
  plan: "trial",
  status: "active",
  require_mfa: false,
  created_at: "2026-01-01T00:00:00Z",
};

const session: Session = {
  user: { id: "u1", email: "owner@example.com", display_name: "Owner" },
  mfa_enabled: false,
  recently_authenticated: true,
  memberships: [],
  active: { membership_id: "m1", organization, role: { key: "owner", name: "Owner" }, permissions: {}, mfa_required: false },
};

const summary: DashboardSummary = {
  period: "30d",
  since: "2026-08-14T00:00:00Z",
  until: "2026-09-13T00:00:00Z",
  currency: "USD",
  activities: { tasks_completed: 9, meetings_completed: 2, calls_completed: 7, tasks_due: 4, tasks_overdue: 2, meetings_upcoming: 3, calls_upcoming: 5 },
  contacts_created: 12,
  lead_conversion: { created: 10, converted: 4, rate: 40 },
  deals_won: { count: 3, amount: "15000.00" },
  deals_lost: { count: 1, amount: "700.00" },
  open_pipeline: { count: 8, amount: "42000.00" },
  weighted_pipeline: { count: 8, amount: "21000.00" },
  win_rate: 75,
  average_deal_size: "5000.00",
  deals_by_stage: {
    pipeline: { id: "p1", name: "Sales pipeline" },
    stages: [
      { id: "s1", name: "Qualification", kind: "open", color_token: "slate", count: 5, amount: "20000.00" },
      { id: "s2", name: "Closed won", kind: "won", color_token: "green", count: 3, amount: "15000.00" },
    ],
  },
  deals_by_owner: [
    { id: "m1", name: "Ada Lovelace", count: 3, amount: "30000.00", weighted: "9000.00" },
    { id: "m2", name: "Grace Hopper", count: 5, amount: "12000.00", weighted: "3600.00" },
  ],
  revenue_trend: [
    { month: "2026-04", count: 0, amount: "0.00" },
    { month: "2026-05", count: 1, amount: "5000.00" },
    { month: "2026-06", count: 0, amount: "0.00" },
    { month: "2026-07", count: 0, amount: "0.00" },
    { month: "2026-08", count: 0, amount: "0.00" },
    { month: "2026-09", count: 2, amount: "10000.00" },
  ],
  forecast: [
    { month: "2026-09", count: 3, amount: "18000.00", weighted: "9000.00" },
    { month: "2026-10", count: 4, amount: "20000.00", weighted: "8000.00" },
    { month: "2026-11", count: 1, amount: "4000.00", weighted: "4000.00" },
  ],
  top_companies: [{ id: "c1", name: "Globex", count: 2, amount: "30000.00" }],
  totals: { contacts: { count: 1248, previous: 1058 }, companies: { count: 386, previous: 345 }, deals: { count: 86, previous: 69 } },
  tickets: { open: 24, overdue: 2, created: 23, created_previous: 25 },
  deals_by_source: [
    { source: "whatsapp", count: 32 },
    { source: "facebook_ads", count: 18 },
    { source: "", count: 2 },
  ],
  top_team: [{ id: "m1", name: "Deepti", count: 24, amount: "1840000.00" }],
  deals_closing_week: 5,
  insights: [
    { key: "follow_ups_today", count: 6 },
    { key: "win_rate_change", points: 6, current: 32 },
  ],
};

const noAccess: DashboardSummary = {
  ...summary,
  activities: null,
  contacts_created: null,
  lead_conversion: null,
  deals_won: null,
  deals_lost: null,
  open_pipeline: null,
  weighted_pipeline: null,
  win_rate: null,
  average_deal_size: null,
  deals_by_stage: null,
  deals_by_owner: null,
  revenue_trend: null,
  forecast: null,
  top_companies: null,
  totals: { contacts: null, companies: null, deals: null },
  tickets: null,
  deals_by_source: null,
  top_team: null,
  deals_closing_week: null,
  insights: [],
};

function pipeline(id: string, name: string): Pipeline {
  return { id, name, position: 0, is_default: id === "p1", parent_id: null, restricted: false, layout: {}, effective_layout: {}, template_key: "", access: { team_ids: [], hierarchy_role_ids: [] }, stages: [], version: 1, archived_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getDashboard).mockReset();
    vi.mocked(listPipelines).mockReset();
    vi.mocked(listPipelines).mockResolvedValue({ next: null, previous: null, results: [pipeline("p1", "Sales pipeline")] });
    vi.mocked(getAssistantHome).mockResolvedValue({
      suggestions: ["Which deals need attention?"],
      generative_available: true,
      knowledge_available: true,
      recent: [],
    });
  });

  it("greets the member and asks for this month by default", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();
    expect(await screen.findByRole("heading", { level: 1, name: /^Good (Morning|Afternoon|Evening), Owner! 👋$/ })).toBeInTheDocument();
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(getDashboard).toHaveBeenCalledWith(month, undefined, 6);
  });

  it("renders the five KPI tiles with growth since the period started", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();
    const kpis = await screen.findByRole("region", { name: "Key figures" });
    expect(await within(kpis).findByRole("link", { name: /Total Contactss*1,248/ })).toHaveAttribute("href", "/contacts");
    expect(within(kpis).getByRole("link", { name: /Companiess*386/ })).toBeInTheDocument();
    expect(within(kpis).getByRole("link", { name: /Total Dealss*86/ })).toBeInTheDocument();
    expect(within(kpis).getByText("$21,000.00")).toBeInTheDocument(); // expected (weighted) revenue
    expect(within(kpis).getByText("75%")).toBeInTheDocument();
    expect(within(kpis).getByText("Up 18% compared with the start of the month")).toBeInTheDocument(); // 1,248 vs 1,058
  });

  it("shows the pipeline tiles, source donut, team and business summary", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();
    const overview = await screen.findByRole("region", { name: "Sales Pipeline Overview" });
    expect(await within(overview).findByRole("link", { name: /Qualifications*5/ })).toHaveAttribute("href", "/pipeline?view=list&stage=s1&pipeline=p1");
    const sources = screen.getByRole("region", { name: "Deals by Source" });
    expect(within(sources).getByText("WhatsApp")).toBeInTheDocument();
    expect(within(sources).getByText("32 (62%)")).toBeInTheDocument();
    expect(within(sources).getByText("Not set")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Top Performing Team" })).getByText("Deepti")).toBeInTheDocument();
    const business = screen.getByRole("region", { name: "Key Business Summary" });
    expect(within(business).getByRole("link", { name: /Open Tickets/ })).toHaveTextContent("24");
    expect(screen.getByRole("img", { name: /Won revenue by month/ })).toBeInTheDocument();
  });

  it("lists upcoming work and the computed insights", async () => {
    vi.mocked(getDashboard).mockResolvedValue({ ...summary, activities: { ...summary.activities!, overdue: 3, due_week: 12 } });
    renderDashboard();
    const upcoming = await screen.findByRole("region", { name: "Upcoming & Overdue" });
    expect(within(upcoming).getByRole("link", { name: "3 Overdue Activities" })).toHaveAttribute("href", "/activities?due=overdue");
    expect(within(upcoming).getByRole("link", { name: "12 Activities Due This Week" })).toBeInTheDocument();
    expect(within(upcoming).getByRole("link", { name: "5 Deals Closing This Week" })).toBeInTheDocument();
    const insights = screen.getByRole("region", { name: "WorkEasy AI Insights" });
    expect(within(insights).getByRole("link", { name: "6 follow-ups are due today." })).toHaveAttribute("href", "/activities?due=today");
    expect(within(insights).getByText("Your win rate improved by 6 points this period.")).toBeInTheDocument();
    expect(within(insights).getByRole("link", { name: /Ask WorkEasy AI/ })).toHaveAttribute("href", "/assistant");
  });

  it("keeps the earlier detail charts under More insights", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();
    expect(await screen.findByRole("table", { name: "Forecast by expected close month" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Sales pipeline funnel" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Globex" })).toHaveAttribute("href", "/companies/c1");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  it("shows no-access notes instead of numbers for modules the member cannot view", async () => {
    vi.mocked(getDashboard).mockResolvedValue(noAccess);
    renderDashboard();
    const kpis = await screen.findByRole("region", { name: "Key figures" });
    expect((await within(kpis).findAllByText("No access")).length).toBe(3);
    expect(screen.getAllByText("Your role does not include access to this data.").length).toBeGreaterThan(0);
  });

  it("offers a pipeline filter only when the organisation has more than one pipeline", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    vi.mocked(listPipelines).mockResolvedValue({ next: null, previous: null, results: [pipeline("p1", "Sales pipeline"), pipeline("p2", "Partners")] });
    renderDashboard();
    expect(await screen.findByRole("combobox", { name: "Pipeline" })).toBeInTheDocument();
  });

  it("keeps the pipeline filter hidden for a single pipeline", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();
    await screen.findByRole("region", { name: "Key figures" });
    expect(screen.queryByRole("combobox", { name: "Pipeline" })).not.toBeInTheDocument();
  });
});
