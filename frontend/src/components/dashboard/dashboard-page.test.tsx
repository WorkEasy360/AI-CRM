import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
}));

import { listPipelines } from "@/lib/api/crm";
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
};

function pipeline(id: string, name: string): Pipeline {
  return { id, name, position: 0, is_default: id === "p1", stages: [], version: 1, archived_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
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
  });

  it("renders the KPI tiles from the summary endpoint", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();

    expect(await screen.findByText("$42,000.00")).toBeInTheDocument(); // pipeline value
    expect(screen.getByText("8 open deals")).toBeInTheDocument();
    expect(screen.getByText("$21,000.00")).toBeInTheDocument(); // weighted pipeline
    expect(screen.getByText("Value × probability")).toBeInTheDocument();
    expect(screen.getByText("75% win rate")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument(); // lead conversion
    expect(screen.getByText("4 converted / 10 created")).toBeInTheDocument();
    expect(screen.getAllByText("$5,000.00").length).toBeGreaterThan(0); // average deal size
    expect(getDashboard).toHaveBeenCalledWith("30d", undefined);

    expect(screen.getByRole("link", { name: /Pipeline value/ })).toHaveAttribute("href", "/pipeline");
    expect(screen.getByRole("link", { name: /Weighted pipeline/ })).toHaveAttribute("href", "/dashboard/forecast");
    expect(screen.getByRole("link", { name: /Deals lost/ })).toHaveAttribute("href", "/pipeline?view=list&status=lost");
  });

  it("renders the activity tiles with overdue and upcoming work", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();

    await screen.findByText("2 overdue"); // the link exists while loading too; wait for the numbers
    const tasks = screen.getByRole("link", { name: /Tasks due/ });
    expect(tasks).toHaveAttribute("href", "/activities?tab=tasks&due=today");
    expect(tasks).toHaveTextContent("4");
    expect(tasks).toHaveTextContent("2 overdue");
    expect(screen.getByRole("link", { name: /Meetings/ })).toHaveTextContent("3");
    const calls = screen.getByRole("link", { name: /Calls/ });
    expect(calls).toHaveTextContent("7");
    expect(calls).toHaveTextContent("5 upcoming");
  });

  it("renders the charts, the owner bars and the top companies", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();

    expect(await screen.findByRole("img", { name: /Revenue by month/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Forecast by month/ })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Forecast by expected close month" })).toBeInTheDocument();
    expect(screen.getByText("Sales pipeline")).toBeInTheDocument();

    const ada = screen.getByRole("link", { name: /Ada Lovelace/ });
    expect(ada).toHaveAttribute("href", "/pipeline?view=list&owner=m1");
    expect(ada).toHaveTextContent("$30,000.00");
    expect(ada).toHaveTextContent("3 deals · $9,000.00 weighted");

    expect(screen.getByRole("link", { name: "Globex" })).toHaveAttribute("href", "/companies/c1");
    expect(screen.getByRole("link", { name: "Forecast" })).toHaveAttribute("href", "/dashboard/forecast");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  it("shows no-access notes instead of numbers for modules the member cannot view", async () => {
    vi.mocked(getDashboard).mockResolvedValue(noAccess);
    renderDashboard();

    expect((await screen.findAllByText("Your role does not include access to this data.")).length).toBe(5);
    expect(screen.getAllByText("Your role does not include Activities")).toHaveLength(3);
    expect(screen.queryByText("$42,000.00")).not.toBeInTheDocument();
    expect(screen.queryByText("overdue")).not.toBeInTheDocument();
  });

  it("offers a pipeline filter only when the organisation has more than one pipeline", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    vi.mocked(listPipelines).mockResolvedValue({ next: null, previous: null, results: [pipeline("p1", "Sales pipeline"), pipeline("p2", "Partners")] });
    renderDashboard();

    expect(await screen.findByRole("combobox", { name: "Pipeline" })).toHaveTextContent("All pipelines");
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveTextContent("Last 30 days");
  });

  it("keeps the pipeline filter hidden for a single pipeline", async () => {
    vi.mocked(getDashboard).mockResolvedValue(summary);
    renderDashboard();

    await screen.findByText("$42,000.00");
    expect(screen.queryByRole("combobox", { name: "Pipeline" })).not.toBeInTheDocument();
  });
});
