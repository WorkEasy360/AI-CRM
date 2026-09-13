import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivitiesPage } from "@/components/activities/activities-page";
import { toIsoWithOffset } from "@/components/activities/activity-utils";
import { ToastProvider } from "@/components/ui/toast";
import type { Activity, ActivitySummary } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  calendarActivities: vi.fn(),
  activitySummary: vi.fn(),
  listActivities: vi.fn(),
  getActivity: vi.fn(),
  createActivity: vi.fn(),
  updateActivity: vi.fn(),
  completeActivity: vi.fn(),
  reopenActivity: vi.fn(),
  deleteActivity: vi.fn(),
  listContacts: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listCompanies: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listDeals: vi.fn(async () => ({ next: null, previous: null, results: [] })),
}));

vi.mock("@/lib/api/endpoints", () => ({
  listMembers: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  getSession: vi.fn(),
}));

let search = "";
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
  usePathname: () => "/activities",
  useSearchParams: () => new URLSearchParams(search),
}));

const SESSION = {
  active: {
    membership_id: "m1",
    organization: { base_currency: "USD" },
    permissions: { "activities.view": "own", "activities.create": "own", "activities.update": "own" },
  },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { activitySummary, calendarActivities, listActivities } from "@/lib/api/crm";

const SUMMARY: ActivitySummary = { overdue: 2, due_today: 1, open_tasks: 5, meetings_week: 3, calls_week: 4 };

function activity(overrides: Partial<Activity> & Pick<Activity, "id" | "kind" | "title" | "start_at">): Activity {
  return {
    description: "",
    status: "open",
    priority: "normal",
    end_at: null,
    all_day: false,
    duration_minutes: 30,
    timezone: "UTC",
    location: "",
    meeting_url: "",
    direction: "",
    outcome: "",
    reminder_minutes: null,
    completed_at: null,
    owner: { id: "m1", display_name: "Ada" },
    contact: null,
    company: null,
    deal: null,
    attendees: [],
    is_overdue: false,
    version: 1,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ActivitiesPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ActivitiesPage", () => {
  beforeAll(() => {
    // Only Date is faked so React Query and testing-library timers keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 13, 10, 0, 0));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    search = "";
    replace.mockReset();
    vi.mocked(activitySummary).mockReset().mockResolvedValue(SUMMARY);
    vi.mocked(calendarActivities).mockReset().mockResolvedValue({ results: [] });
    vi.mocked(listActivities).mockReset().mockResolvedValue({ next: null, previous: null, results: [] });
  });

  it("renders the tabs, the New split button and the summary chips", async () => {
    renderPage();

    const tabs = screen.getByRole("tablist", { name: "Activity views" });
    expect(within(tabs).getByRole("tab", { name: "calendar" })).toHaveAttribute("aria-selected", "true");
    expect(within(tabs).getByRole("tab", { name: "tasks" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "meetings" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "calls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More ways to add" })).toBeInTheDocument();

    expect(await screen.findByRole("button", { name: "2 Overdue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 Meetings this week" })).toBeInTheDocument();
    expect(activitySummary).toHaveBeenCalledWith("me");
  });

  it("renders calendar events for the visible month from calendarActivities", async () => {
    vi.mocked(calendarActivities).mockResolvedValue({
      results: [
        activity({ id: "a1", kind: "meeting", title: "Demo with Acme", start_at: toIsoWithOffset(new Date(2026, 8, 15, 14, 0)) }),
        activity({ id: "a2", kind: "call", title: "Follow-up call", start_at: toIsoWithOffset(new Date(2026, 8, 22, 9, 30)) }),
      ],
    });
    renderPage();

    expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Demo with Acme/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Follow-up call/ })).toBeInTheDocument();
    // The six-week grid (31 Aug – 11 Oct) plus one day of padding on each side, scoped to my calendar.
    expect(calendarActivities).toHaveBeenCalledWith("2026-08-30", "2026-10-12", { owner: "me" });

    const cell = screen.getByRole("gridcell", { name: /Tue Sep 15 2026/ });
    expect(within(cell).getByRole("button", { name: /Demo with Acme/ })).toBeInTheDocument();
  });

  it("lists tasks grouped by day on the Tasks tab", async () => {
    search = "tab=tasks";
    vi.mocked(listActivities).mockResolvedValue({
      next: null,
      previous: null,
      results: [
        activity({ id: "t1", kind: "task", title: "Chase invoice", start_at: toIsoWithOffset(new Date(2026, 8, 10, 9, 0)), is_overdue: true }),
        activity({ id: "t2", kind: "task", title: "Prepare deck", start_at: toIsoWithOffset(new Date(2026, 8, 13, 16, 0)) }),
        activity({ id: "t3", kind: "task", title: "Book venue", start_at: null }),
      ],
    });
    renderPage();

    expect(screen.getByRole("tab", { name: "tasks" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Chase invoice")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Overdue" })).getByText("Chase invoice")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Today" })).getByText("Prepare deck")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "No date" })).getByText("Book venue")).toBeInTheDocument();
    await waitFor(() => expect(listActivities).toHaveBeenCalledWith({ kind: "task", owner: "me", open: "true", q: undefined, due: undefined, sort: "start_at" }, null));
  });
});
