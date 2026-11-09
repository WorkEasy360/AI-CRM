import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { ToastProvider } from "@/components/ui/toast";
import type { Activity, Pipeline } from "@/lib/api/crm-types";
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
  completeActivity: vi.fn(),
  reopenActivity: vi.fn(),
  deleteActivity: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
}));

import { completeActivity, getAssistantHome, getMyDay, listActivities, listPipelines } from "@/lib/api/crm";
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
  leads: {
    total: 1248,
    previous_total: 1058,
    active: 428,
    previous_active: 400,
    by_status: [
      { status: "lead", label: "Lead", count: 312 },
      { status: "prospect", label: "Prospect", count: 116 },
      { status: "qualified", label: "Qualified", count: 0 },
      { status: "customer", label: "Customer", count: 600 },
      { status: "inactive", label: "Inactive", count: 220 },
    ],
  },
  previous: { since: "2026-07-14T00:00:00Z", deals_created: 3, deals_won: { count: 2, amount: "10000.00" }, open_amount: "40000.00", win_rate: 50 },
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
  leads: null,
  previous: null,
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

function activity(overrides: Partial<Activity> & Pick<Activity, "id" | "title">): Activity {
  return {
    kind: "task",
    description: "",
    status: "pending",
    start_at: new Date().toISOString(),
    end_at: null,
    outcome: "",
    contact: null,
    company: null,
    deal: null,
    version: 1,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...overrides,
  } as Activity;
}

function pipeline(id: string, name: string): Pipeline {
  return { id, name, position: 0, is_default: id === "p1", parent_id: null, restricted: false, layout: {}, effective_layout: {}, template_key: "", access: { team_ids: [], hierarchy_role_ids: [] }, stages: [], version: 1, archived_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DashboardPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getDashboard).mockReset();
    vi.mocked(listPipelines).mockReset();
    vi.mocked(listActivities).mockResolvedValue({ next: null, previous: null, results: [] });
    vi.mocked(getMyDay).mockResolvedValue({ date: "2026-11-05", timezone: "UTC", overdue: [], tasks: [], events: [], calls: [], no_date: [], completed_today: 0 });
    vi.mocked(listPipelines).mockResolvedValue({ next: null, previous: null, results: [pipeline("p1", "Sales pipeline")] });
    vi.mocked(getAssistantHome).mockResolvedValue({
      suggestions: ["Which deals need attention?"],
      generative_available: true,
      knowledge_available: true,
      recent: [],
    });
  });

  it("opens on this month and the member's own records", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(getDashboard).toHaveBeenCalledWith(month, undefined, 6, "me");
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveTextContent("This Month");
    expect(screen.getByRole("combobox", { name: "Records" })).toHaveTextContent("My Records");
  });

  it("renders the five KPI tiles, each opening its records, with the change against the previous period", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();
    const kpis = await screen.findByRole("region", { name: "Key figures" });
    expect(await within(kpis).findByRole("link", { name: /Total Leads\s*1,248/ })).toHaveAttribute("href", "/contacts");
    expect(within(kpis).getByRole("link", { name: /Active Leads\s*428/ })).toBeInTheDocument();
    expect(within(kpis).getByRole("link", { name: /Open Deals\s*\$42,000/ })).toHaveAttribute("href", "/pipeline?view=list&status=open&owner=me");
    const wonLink = within(kpis).getByRole("link", { name: /Won Deals\s*\$15,000/ });
    expect(wonLink.getAttribute("href")).toMatch(/status=won&closed_period=\d{4}-\d{2}&owner=me$/);
    expect(within(kpis).getByRole("link", { name: /Conversion Rate\s*75%/ })).toHaveAttribute("href", "/pipeline?tab=analytics");
    expect(within(kpis).getByText("Up 18% compared with the previous period")).toBeInTheDocument(); // 1,248 vs 1,058
    expect(within(kpis).getByText("Up 25 points compared with the previous period")).toBeInTheDocument(); // 75 vs 50
  });

  it("draws the stage bars and the leads donut, each mark opening its records", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();
    const bars = await screen.findByRole("region", { name: "Sales Pipeline (Deals)" });
    expect(await within(bars).findByRole("link", { name: /5\s*Qualification/ })).toHaveAttribute("href", "/pipeline?view=list&stage=s1&closed_period=all&pipeline=p1");
    const donut = screen.getByRole("region", { name: "Leads by Status" });
    expect(within(donut).getByRole("img", { name: "Leads by status: 1,248 in total" })).toBeInTheDocument();
    const row = within(donut).getByRole("link", { name: /^Lead\s*312\s*25%$/ });
    expect(row).toHaveAttribute("href", "/contacts?lifecycle=lead");
    // A real zero stays a zero; it is not dropped from the list.
    expect(within(donut).getByRole("link", { name: /^Qualified\s*0\s*0%$/ })).toBeInTheDocument();
  });

  it("offers the four quick actions the member's role allows", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    vi.mocked(getSession).mockResolvedValue({ ...session, active: { ...session.active!, permissions: { "contacts.create": "all", "activities.create": "all" } } });
    renderDashboard();
    const quick = await screen.findByRole("region", { name: "Quick Actions" });
    expect(await within(quick).findByRole("button", { name: "Add Lead" })).toBeInTheDocument();
    expect(within(quick).getByRole("button", { name: "Add Task" })).toBeInTheDocument();
    expect(within(quick).getByRole("button", { name: "Schedule Follow-up" })).toBeInTheDocument();
    expect(within(quick).queryByRole("button", { name: "Add Deal" })).not.toBeInTheDocument();
  });

  it("lists today's follow-ups with call, WhatsApp and done actions", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    vi.mocked(getSession).mockResolvedValue({ ...session, active: { ...session.active!, permissions: { "activities.view": "all", "activities.update": "all", "whatsapp.send": "all" } } });
    vi.mocked(getMyDay).mockResolvedValue({
      date: "2026-11-05",
      timezone: "UTC",
      overdue: [],
      no_date: [],
      completed_today: 0,
      events: [],
      calls: [],
      tasks: [activity({ id: "a1", title: "Proposal discussion", contact: { id: "c1", name: "Rahul Mehta", phone: "+919876543210", whatsapp_opt_in: true }, company: { id: "co1", name: "Acme Enterprises" } })],
    });
    vi.mocked(completeActivity).mockResolvedValue(activity({ id: "a1", title: "Proposal discussion" }));
    renderDashboard();
    const panel = await screen.findByRole("region", { name: "Today's Follow-ups" });
    expect(await within(panel).findByText("Acme Enterprises")).toBeInTheDocument();
    expect(within(panel).getByText("Rahul Mehta • Proposal discussion")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "View All (1)" })).toHaveAttribute("href", "/activities?tab=day");
    expect(within(panel).getByRole("link", { name: "Call Rahul Mehta" })).toHaveAttribute("href", "tel:+919876543210");
    expect(within(panel).getByRole("button", { name: "WhatsApp Rahul Mehta" })).toBeEnabled();
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Mark Proposal discussion done" }));
    await waitFor(() => expect(completeActivity).toHaveBeenCalledWith("a1", 1, expect.anything()));
  });

  it("lists pending tasks, soonest first, labelling what is overdue, and asks only for the member's own", async () => {
    vi.mocked(getDashboard).mockResolvedValue({ ...summary, activities: { ...summary.activities!, tasks_open: 7 } });
    vi.mocked(getSession).mockResolvedValue({ ...session, active: { ...session.active!, permissions: { "activities.view": "all" } } });
    vi.mocked(listActivities).mockResolvedValue({ next: null, previous: null, results: [activity({ id: "t1", title: "Send revised proposal", start_at: "2020-01-01T10:00:00Z" })] });
    renderDashboard();
    const panel = await screen.findByRole("region", { name: "Pending Tasks" });
    expect(await within(panel).findByText("Send revised proposal")).toBeInTheDocument();
    expect(within(panel).getByText("Overdue")).toBeInTheDocument();
    expect(await within(panel).findByRole("link", { name: "View All (7)" })).toBeInTheDocument();
    expect(listActivities).toHaveBeenCalledWith(expect.objectContaining({ kind: "task", open: "1", owner: "me", sort: "start_at" }));
  });

  it("keeps the earlier panels under More insights", async () => {
    vi.mocked(getDashboard).mockResolvedValue({ ...summary, activities: { ...summary.activities!, overdue: 3, due_week: 12 } });
    renderDashboard();
    expect(await screen.findByRole("table", { name: "Forecast by expected close month" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Sales pipeline funnel" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Globex" })).toHaveAttribute("href", "/companies/c1");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");

    const sources = screen.getByRole("region", { name: "Deals by Source" });
    expect(within(sources).getByText("32 (62%)")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Top Performing Team" })).getByText("Deepti")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Key Business Summary" })).getByRole("link", { name: /Open Tickets/ })).toHaveTextContent("24");
    expect(screen.getByRole("img", { name: /Won revenue by month/ })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Sales Pipeline Overview" })).getByRole("link", { name: /Qualification\s*5/ })).toHaveAttribute("href", "/pipeline?view=list&stage=s1&closed_period=all&pipeline=p1");

    const upcoming = screen.getByRole("region", { name: "Upcoming & Overdue" });
    expect(within(upcoming).getByRole("link", { name: "3 Overdue Activities" })).toHaveAttribute("href", "/activities?due=overdue");
    const insights = screen.getByRole("region", { name: "WorkEasy AI Insights" });
    expect(within(insights).getByRole("link", { name: "6 follow-ups are due today." })).toHaveAttribute("href", "/activities?due=today");
    expect(within(insights).getByRole("link", { name: /Ask WorkEasy AI/ })).toHaveAttribute("href", "/assistant");
  });

  it("shows no-access notes instead of numbers for modules the member cannot view", async () => {
    vi.mocked(getDashboard).mockResolvedValue(noAccess);
    renderDashboard();
    const kpis = await screen.findByRole("region", { name: "Key figures" });
    expect((await within(kpis).findAllByText("No access")).length).toBe(5);
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
