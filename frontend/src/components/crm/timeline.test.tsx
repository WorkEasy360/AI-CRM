import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "@/components/crm/timeline";
import type { TimelineEvent, TimelinePage } from "@/lib/api/crm-types";

vi.mock("@/lib/api/crm", () => ({
  getTimelinePage: vi.fn(),
  fileDownloadUrl: (id: string) => `/api/v1/files/${id}/download/`,
}));

import { getTimelinePage } from "@/lib/api/crm";

const alex = { id: "m1", display_name: "Alex" };
const now = new Date();
const iso = (daysAgo: number, hour = 9) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, 0, 0);
  return d.toISOString();
};

const events: TimelineEvent[] = [
  { id: "e1", kind: "activity.call", occurred_at: iso(0, 10), actor: alex, data: { activity_id: "a1", title: "Pricing call", status: "completed", outcome: "interested", duration_minutes: 20, direction: "outbound" } },
  { id: "e2", kind: "email", occurred_at: iso(0, 9), actor: alex, data: { message_id: "em1", direction: "outbound", status: "sent", subject: "Proposal", snippet: "Hi Hank, here is the proposal we discussed.", from_address: "alex@keel.test", to_addresses: ["hank@globex.test"], ai_assisted: true } },
  { id: "e3", kind: "lifecycle.changed", occurred_at: iso(1, 15), actor: alex, data: { from_stage: "lead", to_stage: "qualified", source: "user", reason: "" } },
  { id: "e4", kind: "record.updated", occurred_at: iso(1, 14), actor: alex, data: { fields: ["Amount", "Expected close date"] } },
  { id: "e5", kind: "record.updated", occurred_at: iso(1, 13), actor: alex, data: { fields: [], owner_from: "Ada", owner_to: "Alex" } },
  { id: "e6", kind: "activity.task", occurred_at: iso(1, 12), actor: alex, data: { activity_id: "a2", title: "Send contract", status: "open", priority: "urgent", start_at: "2026-12-01" } },
  { id: "e7", kind: "activity.meeting", occurred_at: iso(1, 11), actor: alex, data: { activity_id: "a3", title: "Kick-off", status: "completed" } },
  { id: "e8", kind: "whatsapp", occurred_at: iso(1, 10), actor: null, data: { message_id: "w1", direction: "inbound", status: "received", message_type: "text", body: "Sounds good, send it over." } },
  { id: "e9", kind: "note", occurred_at: iso(10, 9), actor: alex, data: { body: "Budget confirmed for Q4." } },
  { id: "e10", kind: "deal.stage_changed", occurred_at: iso(10, 8), actor: alex, data: { from_stage: { id: "s1", name: "Qualified", kind: "open" }, to_stage: { id: "s2", name: "Proposal", kind: "open" } } },
  { id: "e11", kind: "record.archived", occurred_at: iso(10, 7), actor: alex, data: {} },
  { id: "e12", kind: "record.restored", occurred_at: iso(10, 6), actor: alex, data: {} },
  { id: "e13", kind: "deal.linked", occurred_at: iso(10, 5), actor: alex, data: { deal_id: "d2", name: "Globex pilot", status: "open", stage: "Proposal", amount: "2500.00", currency: "USD" } },
  { id: "e14", kind: "record.created", occurred_at: iso(30, 9), actor: alex, data: {} },
];

const SOURCES = [
  { key: "record", label: "Record" },
  { key: "notes", label: "Notes" },
  { key: "activities", label: "Activities" },
  { key: "emails", label: "Emails" },
  { key: "files", label: "Files" },
];

const page = (results: TimelineEvent[], next_before: string | null = null): TimelinePage => ({ results, next_before, sources: SOURCES });

function renderTimeline() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Timeline entity="deal" recordId="d1" />
    </QueryClientProvider>,
  );
}

describe("Timeline", () => {
  beforeEach(() => {
    vi.mocked(getTimelinePage).mockReset();
    vi.mocked(getTimelinePage).mockResolvedValue(page(events));
  });

  it("renders every event kind as a sentence, grouped by day and newest first", async () => {
    renderTimeline();

    // Day headers.
    const today = await screen.findByRole("region", { name: "Today" });
    expect(screen.getByRole("region", { name: "Yesterday" })).toBeInTheDocument();
    const headers = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headers[0]).toBe("Today");
    expect(headers[1]).toBe("Yesterday");
    expect(headers).toHaveLength(4);

    // Call with outcome and duration, linked to the activities page.
    expect(within(today).getByText(/logged a call/)).toBeInTheDocument();
    expect(within(today).getByRole("link", { name: "Interested, 20 min" })).toHaveAttribute("href", "/activities?open=a1");
    // Email with recipient, subject and an expandable snippet.
    expect(within(today).getByText("Email sent to hank@globex.test")).toBeInTheDocument();
    expect(within(today).getByText("Proposal")).toBeInTheDocument();
    expect(within(today).getByText("AI-assisted")).toBeInTheDocument();
    expect(screen.queryByText(/here is the proposal/)).not.toBeInTheDocument();

    // Status change, field updates, owner change.
    expect(screen.getByText("Status changed")).toBeInTheDocument();
    expect(screen.getByText(/Lead → Qualified/)).toBeInTheDocument();
    expect(screen.getByText("Amount, expected close date")).toBeInTheDocument();
    expect(screen.getByText("Owner changed")).toBeInTheDocument();
    expect(screen.getByText(/Ada → Alex/)).toBeInTheDocument();

    // Task with priority, meeting, inbound WhatsApp.
    expect(screen.getByRole("link", { name: /Send contract/ })).toHaveAttribute("href", "/activities?open=a2");
    expect(screen.getByText("urgent")).toBeInTheDocument();
    expect(screen.getByText(/held a meeting/)).toBeInTheDocument();
    expect(screen.getByText("WhatsApp received")).toBeInTheDocument();
    expect(screen.getByText("Sounds good, send it over.")).toBeInTheDocument();

    // Existing kinds still render.
    expect(screen.getByText("Budget confirmed for Q4.")).toBeInTheDocument();
    expect(screen.getByText(/moved the deal/)).toBeInTheDocument();
    expect(screen.getByText(/archived this deal/)).toBeInTheDocument();
    expect(screen.getByText(/restored this deal/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Globex pilot" })).toHaveAttribute("href", "/deals/d2");
    expect(screen.getByText(/created this deal/)).toBeInTheDocument();
  });

  it("expands an email snippet on demand", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await user.click(await screen.findByRole("button", { name: "Show preview" }));
    expect(screen.getByText("Hi Hank, here is the proposal we discussed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(screen.queryByText("Hi Hank, here is the proposal we discussed.")).not.toBeInTheDocument();
  });

  it("builds the filter chips from the server's sources and passes the selection to the API", async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByText(/logged a call/);
    expect(getTimelinePage).toHaveBeenLastCalledWith("deal", "d1", { before: null, limit: 30, sources: [], kinds: [] });
    const chips = screen.getByRole("group", { name: "Filter timeline" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Record", "Notes", "Activities", "Emails", "Files"]);

    vi.mocked(getTimelinePage).mockResolvedValue(page(events.filter((e) => e.kind.startsWith("activity."))));
    await user.click(screen.getByRole("button", { name: "Activities" }));
    await waitFor(() => expect(getTimelinePage).toHaveBeenLastCalledWith("deal", "d1", { before: null, limit: 30, sources: ["activities"], kinds: [] }));
    expect(screen.getByRole("button", { name: "Activities" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.queryByText("Budget confirmed for Q4.")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Emails" }));
    await waitFor(() => expect(getTimelinePage).toHaveBeenLastCalledWith("deal", "d1", { before: null, limit: 30, sources: ["activities", "emails"], kinds: [] }));

    await user.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(getTimelinePage).toHaveBeenLastCalledWith("deal", "d1", { before: null, limit: 30, sources: [], kinds: [] }));
  });

  it("loads older events with next_before", async () => {
    const user = userEvent.setup();
    vi.mocked(getTimelinePage).mockImplementation(async (_type, _id, opts) =>
      opts?.before ? page([{ id: "old", kind: "note", occurred_at: iso(60, 9), actor: alex, data: { body: "Very first note." } }]) : page(events.slice(0, 3), "2026-01-01T00:00:00Z"),
    );
    renderTimeline();
    await screen.findByText(/logged a call/);
    expect(screen.queryByText("Very first note.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Very first note.")).toBeInTheDocument();
    expect(getTimelinePage).toHaveBeenLastCalledWith("deal", "d1", { before: "2026-01-01T00:00:00Z", limit: 30, sources: [], kinds: [] });
    expect(screen.getByText(/logged a call/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
  });

  it("renders attached files and kinds it does not know yet", async () => {
    vi.mocked(getTimelinePage).mockResolvedValue(
      page([
        { id: "f1", kind: "file", occurred_at: iso(0, 11), actor: alex, data: { file_id: "file1", filename: "contract.pdf", content_type: "application/pdf", size_bytes: 2048 } },
        { id: "x1", kind: "payment.received", occurred_at: iso(0, 10), actor: null, data: { title: "Invoice #42" }, source: "payments" },
      ]),
    );
    renderTimeline();
    expect(await screen.findByRole("link", { name: "contract.pdf" })).toHaveAttribute("href", "/api/v1/files/file1/download/");
    expect(screen.getByText(/Attached/)).toBeInTheDocument();
    expect(screen.getByText(/Invoice #42/)).toBeInTheDocument();
  });
});
