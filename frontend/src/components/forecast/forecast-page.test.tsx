import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForecastPage } from "@/components/forecast/forecast-page";
import type { Forecast } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/endpoints", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/api/crm", () => ({
  getForecast: vi.fn(),
  listPipelines: vi.fn(),
}));

/** A tiny URL store so `router.replace` really changes what `useSearchParams` returns. */
const nav = vi.hoisted(() => {
  let search = "";
  const listeners = new Set<() => void>();
  const set = (next: string) => {
    search = next;
    listeners.forEach((l) => l());
  };
  return {
    get: () => search,
    set,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    replace: vi.fn((url: string) => {
      const i = url.indexOf("?");
      set(i >= 0 ? url.slice(i + 1) : "");
    }),
  };
});

vi.mock("next/navigation", async () => {
  const React = await import("react");
  return {
    useRouter: () => ({ push: vi.fn(), replace: nav.replace, prefetch: vi.fn() }),
    usePathname: () => "/dashboard/forecast",
    useSearchParams: () => {
      const search = React.useSyncExternalStore(nav.subscribe, nav.get, nav.get);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

import { getForecast, listPipelines } from "@/lib/api/crm";
import { getSession } from "@/lib/api/endpoints";

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
  active: { membership_id: "m1", organization, role: { key: "owner", name: "Owner" }, permissions: { "reports.view": "all" }, mfa_required: false },
};

const forecast: Forecast = {
  period: "month",
  from: "2026-09-01",
  to: "2026-09-30",
  currency: "USD",
  pipeline: null,
  group_by: "stage",
  totals: {
    pipeline: { count: 6, amount: "60000.00" },
    weighted: { count: 6, amount: "27000.00" },
    committed: { count: 2, amount: "18000.00" },
    best_case: { count: 6, amount: "60000.00" },
    won: { count: 2, amount: "12000.00" },
    lost: { count: 1, amount: "3000.00" },
    expected_revenue: "39000.00",
  },
  coverage: { open_deals: 10, in_period: 6, without_close_date: 3, overdue: 1 },
  breakdown: [
    { id: "s1", label: "Qualification", count: 4, amount: "40000.00", weighted: "12000.00", committed: "0.00", won_count: 0, won_amount: "0.00" },
    { id: "s2", label: "Proposal", count: 2, amount: "20000.00", weighted: "15000.00", committed: "18000.00", won_count: 0, won_amount: "0.00" },
  ],
  series: [{ month: "2026-09", open_count: 6, pipeline: "60000.00", weighted: "27000.00", won_count: 2, won: "12000.00" }],
  committed_probability: 70,
};

const byOwner: Forecast = {
  ...forecast,
  group_by: "owner",
  breakdown: [{ id: "m1", label: "Ada Lovelace", count: 6, amount: "60000.00", weighted: "27000.00", committed: "18000.00", won_count: 2, won_amount: "12000.00" }],
};

function renderForecast() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ForecastPage />
    </QueryClientProvider>,
  );
}

describe("ForecastPage", () => {
  beforeAll(() => {
    // Radix selects rely on pointer-capture and scrollIntoView, which jsdom does not implement.
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    nav.set("");
    nav.replace.mockClear();
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(listPipelines).mockResolvedValue({ next: null, previous: null, results: [] });
    vi.mocked(getForecast).mockReset();
    vi.mocked(getForecast).mockImplementation(async (params) => (params.group_by === "owner" ? byOwner : forecast));
  });

  it("renders the totals, coverage and breakdown for the current month", async () => {
    renderForecast();

    expect((await screen.findAllByText("$27,000.00")).length).toBeGreaterThan(0); // weighted headline
    expect(screen.getByText("$39,000.00")).toBeInTheDocument(); // expected revenue
    expect(screen.getByText("6 deals closing in period")).toBeInTheDocument();
    expect(screen.getByText("2 deals at ≥ 70% probability")).toBeInTheDocument();
    expect(screen.getByText(/Weighted = value × probability/)).toBeInTheDocument();
    expect(screen.getByText(/Based on/)).toHaveTextContent("Based on 6 open deals closing in the period · 3 open deals have no close date · 1 overdue");
    expect(screen.getByRole("link", { name: "Review close dates" })).toHaveAttribute("href", "/pipeline?view=list&sort=expected_close_date");

    expect(screen.getByRole("img", { name: /Pipeline, weighted and won by month/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Qualification" })).toHaveAttribute("href", "/pipeline?view=list&stage=s1");
    expect(screen.getByRole("link", { name: "Proposal" })).toHaveAttribute("href", "/pipeline?view=list&stage=s2");
    expect(screen.getByRole("row", { name: /Total/ })).toHaveTextContent("$60,000.00");
    expect(screen.getByRole("link", { name: "Forecast" })).toHaveAttribute("aria-current", "page");

    expect(getForecast).toHaveBeenCalledWith({ period: "month", from: undefined, to: undefined, pipeline: undefined, group_by: "stage" });
  });

  it("refetches with the chosen dimension when the group-by changes", async () => {
    const user = userEvent.setup();
    renderForecast();
    await screen.findByRole("link", { name: "Qualification" });

    await user.click(screen.getByRole("combobox", { name: "Group by" }));
    await user.click(await screen.findByRole("option", { name: "Salesperson" }));

    expect(nav.replace).toHaveBeenCalledWith("/dashboard/forecast?group_by=owner", { scroll: false });
    await waitFor(() => expect(getForecast).toHaveBeenCalledWith(expect.objectContaining({ group_by: "owner" })));
    expect(await screen.findByRole("link", { name: "Ada Lovelace" })).toHaveAttribute("href", "/pipeline?view=list&owner=m1");
    expect(screen.getByRole("columnheader", { name: "Salesperson" })).toBeInTheDocument();
  });

  it("asks for a date range before fetching a custom period", async () => {
    nav.set("period=custom");
    renderForecast();

    expect(await screen.findByText("Choose a date range")).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(getForecast).not.toHaveBeenCalled();
  });

  it("explains when the role cannot see forecasts", async () => {
    vi.mocked(getSession).mockResolvedValue({ ...session, active: { ...session.active!, permissions: {} } });
    renderForecast();

    expect(await screen.findByText("Forecast is not available for your role")).toBeInTheDocument();
    expect(getForecast).not.toHaveBeenCalled();
  });
});
