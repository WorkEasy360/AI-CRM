import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordActivities } from "@/components/activities/record-activities";
import { ToastProvider } from "@/components/ui/toast";
import type { Activity } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  listRecordActivities: vi.fn(),
  completeActivity: vi.fn(),
  reopenActivity: vi.fn(),
  deleteActivity: vi.fn(),
  createActivity: vi.fn(),
  updateActivity: vi.fn(),
  getActivity: vi.fn(),
  listContacts: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listCompanies: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listDeals: vi.fn(async () => ({ next: null, previous: null, results: [] })),
}));

vi.mock("@/lib/api/endpoints", () => ({
  listMembers: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  getSession: vi.fn(),
}));

const SESSION = {
  active: {
    membership_id: "m1",
    organization: { base_currency: "USD" },
    permissions: { "activities.view": "own", "activities.create": "own", "activities.update": "own", "activities.delete": "own" },
  },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { completeActivity, listRecordActivities } from "@/lib/api/crm";

function activity(overrides: Partial<Activity> & Pick<Activity, "id" | "kind" | "title">): Activity {
  return {
    description: "",
    status: "open",
    priority: "normal",
    start_at: "2026-09-20T09:00:00Z",
    end_at: null,
    all_day: false,
    duration_minutes: null,
    timezone: "UTC",
    location: "",
    meeting_url: "",
    direction: "",
    outcome: "",
    reminder_minutes: null,
    completed_at: null,
    owner: { id: "m1", display_name: "Ada" },
    contact: { id: "c1", name: "Grace Hopper" },
    company: null,
    deal: null,
    attendees: [],
    is_overdue: false,
    version: 3,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RecordActivities entity="contact" recordId="c1" record={{ contact: { id: "c1", name: "Grace Hopper" } }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("RecordActivities", () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    vi.mocked(listRecordActivities).mockReset();
    vi.mocked(completeActivity).mockReset();
  });

  it("lists the record's open activities with their links and create buttons", async () => {
    vi.mocked(listRecordActivities).mockResolvedValue({
      next: null,
      previous: null,
      results: [
        activity({ id: "a1", kind: "task", title: "Send proposal", priority: "high", is_overdue: true, deal: { id: "d1", name: "Acme renewal" } }),
        activity({ id: "a2", kind: "call", title: "Intro call", direction: "outbound", outcome: "connected" }),
      ],
    });
    renderPanel();

    expect(await screen.findByText("Send proposal")).toBeInTheDocument();
    expect(screen.getByText("Intro call")).toBeInTheDocument();
    expect(listRecordActivities).toHaveBeenCalledWith("contact", "c1", expect.objectContaining({ open: "true", sort: "start_at" }), null);

    const task = screen.getByTestId("activity-a1");
    expect(within(task).getByText("High")).toBeInTheDocument();
    expect(within(task).getByText(/Overdue/)).toBeInTheDocument();
    expect(within(task).getByRole("link", { name: /Acme renewal/ })).toHaveAttribute("href", "/deals/d1");
    const call = screen.getByTestId("activity-a2");
    expect(within(call).getByText("Outbound")).toBeInTheDocument();
    expect(within(call).getByText("Connected")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New call" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New meeting" })).toBeInTheDocument();
  });

  it("completes a task from its checkbox with the current version", async () => {
    const user = userEvent.setup();
    vi.mocked(listRecordActivities).mockResolvedValue({ next: null, previous: null, results: [activity({ id: "a1", kind: "task", title: "Send proposal" })] });
    vi.mocked(completeActivity).mockImplementation(async (id, version) => activity({ id, kind: "task", title: "Send proposal", status: "completed", version: version + 1 }));
    renderPanel();

    await user.click(await screen.findByRole("checkbox", { name: "Mark Send proposal as done" }));

    await waitFor(() => expect(completeActivity).toHaveBeenCalledTimes(1));
    expect(vi.mocked(completeActivity).mock.calls[0]?.slice(0, 2)).toEqual(["a1", 3]);
    expect(await screen.findByText("Marked as done")).toBeInTheDocument();
  });

  it("asks for an outcome before completing a call that has none", async () => {
    const user = userEvent.setup();
    vi.mocked(listRecordActivities).mockResolvedValue({ next: null, previous: null, results: [activity({ id: "a2", kind: "call", title: "Intro call", direction: "outbound" })] });
    vi.mocked(completeActivity).mockImplementation(async (id, version, input) => activity({ id, kind: "call", title: "Intro call", status: "completed", version: version + 1, outcome: (input?.outcome as Activity["outcome"]) ?? "" }));
    renderPanel();

    await user.click(await screen.findByRole("checkbox", { name: "Mark Intro call as done" }));
    const dialog = await screen.findByRole("dialog", { name: "How did the call go?" });
    expect(completeActivity).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("combobox", { name: "Outcome" }));
    await user.click(await screen.findByRole("option", { name: "Voicemail" }));
    await user.click(within(dialog).getByRole("button", { name: "Mark as done" }));

    await waitFor(() => expect(completeActivity).toHaveBeenCalledWith("a2", 3, { outcome: "voicemail", note: undefined }));
  });

  it("shows an empty state with a create action when nothing is open", async () => {
    vi.mocked(listRecordActivities).mockResolvedValue({ next: null, previous: null, results: [] });
    renderPanel();

    expect(await screen.findByText("No open activities")).toBeInTheDocument();
    // The header "+ Task" button and the empty-state action both offer a new task.
    expect(screen.getAllByRole("button", { name: "New task" })).toHaveLength(2);
  });
});
