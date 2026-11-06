import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivitiesPage } from "@/components/activities/activities-page";
import { toIsoWithOffset } from "@/components/activities/activity-utils";
import { ToastProvider } from "@/components/ui/toast";
import type { Activity, ActivitySummary, MyDay } from "@/lib/api/crm-types";
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
  bulkActivities: vi.fn(),
  getMyDay: vi.fn(),
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

const BASE_PERMISSIONS = { "activities.view": "own", "activities.create": "own", "activities.update": "own" };

function sessionWith(permissions: Record<string, string>): Session {
  return { active: { membership_id: "m1", organization: { base_currency: "USD" }, permissions } } as unknown as Session;
}

let session = sessionWith(BASE_PERMISSIONS);

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: session }) };
});

import { activitySummary, bulkActivities, calendarActivities, getMyDay, listActivities } from "@/lib/api/crm";

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
    parent_id: null,
    subtask_count: 0,
    subtasks_done: 0,
    recurrence: "",
    series_id: null,
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
    session = sessionWith(BASE_PERMISSIONS);
    vi.mocked(bulkActivities).mockReset();
    replace.mockReset();
    vi.mocked(activitySummary).mockReset().mockResolvedValue(SUMMARY);
    vi.mocked(calendarActivities).mockReset().mockResolvedValue({ results: [] });
    vi.mocked(listActivities).mockReset().mockResolvedValue({ next: null, previous: null, results: [] });
    vi.mocked(getMyDay).mockReset().mockResolvedValue({ date: "2026-09-13", timezone: "UTC", overdue: [], tasks: [], events: [], calls: [], no_date: [], completed_today: 0 });
  });

  it("renders the tabs, the New split button, the KPIs and the schedule column", async () => {
    vi.mocked(activitySummary).mockResolvedValue({
      ...SUMMARY,
      due_week: 12,
      follow_ups: 2,
      totals: { all: 248, task: 132, call: 68, meeting: 48 },
      created: { days: 30, current: { all: 59, task: 28, call: 18, meeting: 13 }, previous: { all: 50, task: 25, call: 15, meeting: 11 } },
    });
    renderPage();

    const tabs = screen.getByRole("tablist", { name: "Activity views" });
    // The WorkEasy360 list of everything is the default view; calendar and my day stay one click away.
    expect(within(tabs).getByRole("tab", { name: "All Activities" })).toHaveAttribute("aria-selected", "true");
    for (const name of ["Tasks", "Calls", "Meetings", "Follow-ups", "Calendar", "My Day"]) expect(within(tabs).getByRole("tab", { name })).toBeInTheDocument();
    // Conversations need their channel's permission.
    expect(within(tabs).queryByRole("tab", { name: "WhatsApp" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More ways to add" })).toBeInTheDocument();

    const kpis = screen.getByRole("region", { name: "Activity summary" });
    expect(await within(kpis).findByText("248")).toBeInTheDocument();
    expect(within(kpis).getAllByText("Up 18% new in the last 30 days vs the 30 before").length).toBeGreaterThan(0);
    expect(activitySummary).toHaveBeenCalledWith();
    expect(await screen.findByRole("region", { name: "Upcoming (12)" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Overdue (2)" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Calendar" })).toBeInTheDocument();
  });

  it("lists everything in the table with due dates, statuses and related records", async () => {
    vi.mocked(listActivities).mockImplementation(async (params) =>
      params.limit
        ? { next: null, previous: null, results: [] }
        : {
            next: null,
            previous: null,
            results: [
              activity({ id: "a1", kind: "call", title: "Follow up call with Apex", start_at: toIsoWithOffset(new Date(2026, 8, 13, 11, 30)), company: { id: "c1", name: "Apex Technologies" } }),
              activity({ id: "a2", kind: "meeting", title: "Product demo meeting", start_at: toIsoWithOffset(new Date(2026, 8, 14, 11, 0)) }),
            ],
          },
    );
    renderPage();
    const table = await screen.findByRole("region", { name: "Activities" });
    expect(await within(table).findByText("Follow up call with Apex")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Apex Technologies" })).toHaveAttribute("href", "/companies/c1");
    expect(within(table).getByText(/^Today, /)).toHaveClass("text-danger");
    expect(within(table).getByText(/^Tomorrow, /)).not.toHaveClass("text-danger");
    expect(within(table).getByText("Scheduled")).toBeInTheDocument();
    expect(within(table).getByText("Showing 1–2 activities")).toBeInTheDocument();
    await waitFor(() => expect(listActivities).toHaveBeenCalledWith({ top_level: "1", sort: "start_at" }, null));
  });

  it("asks the API for open follow-ups on the Follow-ups tab", async () => {
    search = "tab=followups";
    renderPage();
    await waitFor(() => expect(listActivities).toHaveBeenCalledWith({ follow_up: "1", top_level: "1", sort: "start_at" }, null));
    search = "tab=all&range=today";
    renderPage();
    await waitFor(() => expect(listActivities).toHaveBeenCalledWith({ from: "2026-09-13", to: "2026-09-13", top_level: "1", sort: "start_at" }, null));
  });

  it("renders calendar events for the visible month from calendarActivities", async () => {
    search = "tab=calendar";
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
    search = "tab=tasks&layout=grouped";
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

    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Chase invoice")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Overdue" })).getByText("Chase invoice")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Today" })).getByText("Prepare deck")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "No date" })).getByText("Book venue")).toBeInTheDocument();
    await waitFor(() => expect(listActivities).toHaveBeenCalledWith({ kind: "task", owner: "me", open: "true", q: undefined, due: undefined, sort: "start_at" }, null));
  });

  describe("bulk actions on a list", () => {
    const TASKS = [
      activity({ id: "t1", kind: "task", title: "Chase invoice", start_at: null }),
      activity({ id: "t2", kind: "task", title: "Prepare deck", start_at: null }),
    ];

    beforeEach(() => {
      search = "tab=tasks&layout=grouped";
      vi.mocked(listActivities).mockResolvedValue({ next: null, previous: null, results: TASKS });
    });

    it("hides selection without activities.bulk_update", async () => {
      renderPage();
      expect(await screen.findByText("Chase invoice")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Select" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument();
    });

    it("marks selected activities complete; reassign needs the all scope", async () => {
      const user = userEvent.setup();
      session = sessionWith({ ...BASE_PERMISSIONS, "activities.bulk_update": "own" });
      vi.mocked(bulkActivities).mockResolvedValue({ action: "complete", requested: 1, affected: 1 });
      renderPage();

      await user.click(await screen.findByRole("button", { name: "Select" }));
      const bar = screen.getByRole("region", { name: "Bulk actions" });
      await user.click(screen.getByRole("checkbox", { name: "Select Chase invoice" }));
      expect(within(bar).getByText("1 activity selected")).toBeInTheDocument();
      expect(within(bar).queryByRole("button", { name: "Reassign" })).not.toBeInTheDocument();

      await user.click(within(bar).getByRole("button", { name: "Mark complete" }));
      await waitFor(() => expect(bulkActivities).toHaveBeenCalledWith({ ids: ["t1"], action: "complete" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Bulk actions" })).not.toBeInTheDocument());
    });

    it("offers Reassign when the actor may update every activity", async () => {
      const user = userEvent.setup();
      session = sessionWith({ ...BASE_PERMISSIONS, "activities.update": "all", "activities.bulk_update": "all" });
      renderPage();

      await user.click(await screen.findByRole("button", { name: "Select" }));
      const bar = screen.getByRole("region", { name: "Bulk actions" });
      await user.click(within(bar).getByRole("button", { name: "Select all 2" }));
      expect(within(bar).getByText("2 activities selected")).toBeInTheDocument();
      expect(within(bar).getByRole("button", { name: "Reassign" })).toBeInTheDocument();
    });
  });

  it("shows my day in sections with the completed count", async () => {
    search = "tab=day";
    const day: MyDay = {
      date: "2026-09-13",
      timezone: "UTC",
      overdue: [activity({ id: "o1", kind: "task", title: "Chase invoice", start_at: toIsoWithOffset(new Date(2026, 8, 10, 9, 0)), is_overdue: true })],
      tasks: [],
      events: [
        activity({ id: "e1", kind: "meeting", title: "Standup", start_at: toIsoWithOffset(new Date(2026, 8, 13, 9, 0)), recurrence: "FREQ=DAILY", occurrence_of: "e1", occurrence_key: "e1:2026-09-13" }),
      ],
      calls: [],
      no_date: [activity({ id: "n1", kind: "task", title: "Book venue", start_at: null })],
      completed_today: 3,
    };
    vi.mocked(getMyDay).mockResolvedValue(day);
    renderPage();

    expect(screen.getByRole("tab", { name: "My Day" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("completed today")).toBeInTheDocument();
    expect(getMyDay).toHaveBeenCalledWith(expect.any(String));
    expect(within(screen.getByRole("region", { name: "Overdue" })).getByText("Chase invoice")).toBeInTheDocument();
    const events = screen.getByRole("region", { name: "Events" });
    expect(within(events).getByText("Standup")).toBeInTheDocument();
    expect(within(events).getByText("Daily")).toBeInTheDocument();
    // An occurrence of a repeating event cannot be ticked off on its own.
    expect(within(events).getByRole("checkbox", { name: "Mark Standup as done" })).toBeDisabled();
    expect(within(screen.getByRole("region", { name: "No date" })).getByRole("checkbox", { name: "Mark Book venue as done" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Calls" })).not.toBeInTheDocument();
  });
});
