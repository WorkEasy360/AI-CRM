import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpdeskPage } from "@/components/helpdesk/helpdesk-page";
import { ToastProvider } from "@/components/ui/toast";
import type { Ticket, TicketSummary } from "@/lib/api/helpdesk";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/helpdesk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/helpdesk")>();
  return {
    ...actual,
    listTickets: vi.fn(),
    ticketSummary: vi.fn(),
    getTicket: vi.fn(),
    listTicketMessages: vi.fn(),
    addTicketMessage: vi.fn(),
    ticketActivity: vi.fn(async () => ({ results: [] })),
    updateTicket: vi.fn(),
    createTicket: vi.fn(),
  };
});
vi.mock("@/lib/api/crm", () => ({
  listProducts: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listFiles: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  uploadFile: vi.fn(),
  getContact: vi.fn(),
}));
vi.mock("@/lib/api/endpoints", () => ({ listMembers: vi.fn(async () => ({ next: null, previous: null, results: [] })) }));

let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/helpdesk",
  useSearchParams: () => new URLSearchParams(search),
}));

let permissions: Record<string, string> = {};
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: { active: { membership_id: "m1", permissions } } as unknown as Session }) };
});

import { addTicketMessage, getTicket, listTicketMessages, listTickets, ticketSummary } from "@/lib/api/helpdesk";

const SUMMARY: TicketSummary = {
  total: 386,
  open: 56,
  in_progress: 42,
  resolved: 276,
  overdue: 12,
  satisfaction: 90,
  rated: 10,
  created: 59,
  avg_resolution_seconds: 4 * 3600 + 36 * 60,
  previous: { days: 30, created: 50, avg_resolution_seconds: 6 * 3600 + 24 * 60 },
  sla_hours: { urgent: 4, high: 8, medium: 24, low: 72 },
};

const TICKET: Ticket = {
  id: "t1",
  number: 1045,
  subject: "WhatsApp API not working",
  description: "Hi Team, our WhatsApp API is not working since morning.",
  status: "open",
  priority: "high",
  category: "technical",
  product: null,
  contact: { id: "c1", display_name: "Rahul Sharma" },
  company: { id: "co1", name: "Apex Technologies" },
  requester_name: "",
  requester: "Rahul Sharma",
  owner: { id: "m1", display_name: "Aman" },
  due_at: "2026-11-05T12:20:00Z",
  is_overdue: false,
  rating: null,
  resolved_at: null,
  version: 1,
  created_at: "2026-11-05T04:50:00Z",
  updated_at: "2026-11-05T05:00:00Z",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <HelpdeskPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("HelpdeskPage", () => {
  beforeEach(() => {
    search = "";
    permissions = { "tickets.view": "all", "tickets.create": "all", "tickets.update": "all" };
    vi.mocked(ticketSummary).mockResolvedValue(SUMMARY);
    vi.mocked(listTickets).mockResolvedValue({ next: null, previous: null, results: [TICKET] });
    vi.mocked(getTicket).mockResolvedValue(TICKET);
    vi.mocked(listTicketMessages).mockResolvedValue({
      results: [{ id: "m1", kind: "reply", channel: "", author: { id: "m1", display_name: "Aman" }, author_name: "", body: "We are checking this issue.", created_at: "2026-11-05T05:00:00Z" }],
    });
  });

  it("shows the KPIs, tabs with counts and the ticket table", async () => {
    renderPage();
    expect(await screen.findByRole("tab", { name: "All Tickets (386)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Overdue (12)" })).toBeInTheDocument();
    const kpis = screen.getByRole("region", { name: "Ticket summary" });
    expect(within(kpis).getByText("4h 36m")).toBeInTheDocument();
    expect(within(kpis).getByText("Avg. Resolution")).toBeInTheDocument();

    const table = screen.getByRole("region", { name: "Tickets" });
    expect(await within(table).findByRole("button", { name: "#TK-1045" })).toBeInTheDocument();
    expect(within(table).getByText("Apex Technologies")).toBeInTheDocument();
    expect(within(table).getByText("Technical")).toBeInTheDocument();
    expect(within(table).getByText("Showing 1–1 of 386 tickets")).toBeInTheDocument();
  });

  it("filters by tab through the list API", async () => {
    search = "tab=resolved";
    renderPage();
    await waitFor(() => expect(listTickets).toHaveBeenCalledWith(expect.objectContaining({ status: "resolved,closed" }), null));
    search = "tab=overdue";
    renderPage();
    await waitFor(() => expect(listTickets).toHaveBeenCalledWith(expect.objectContaining({ overdue: "1" }), null));
  });

  it("opens the details panel with the conversation and posts a reply", async () => {
    search = "open=t1";
    const user = userEvent.setup();
    vi.mocked(addTicketMessage).mockResolvedValue({ id: "m2", kind: "reply", channel: "", author: null, author_name: "", body: "Fixed.", created_at: "2026-11-05T06:00:00Z" });
    renderPage();
    const panel = (await screen.findAllByRole("region", { name: "Ticket Details" }))[0]!;
    expect(within(panel).getByText("WhatsApp API not working")).toBeInTheDocument();
    expect(await within(panel).findByText("We are checking this issue.")).toBeInTheDocument();
    // the description opens the thread as the customer's first message
    expect(within(panel).getByText(/our WhatsApp API is not working/)).toBeInTheDocument();
    await user.type(within(panel).getByRole("textbox", { name: "Reply" }), "Fixed.");
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(addTicketMessage).toHaveBeenCalledWith("t1", { kind: "reply", body: "Fixed.", send_via: "" }));
  });

  it("hides the composer and actions from read-only roles", async () => {
    search = "open=t1";
    permissions = { "tickets.view": "all" };
    renderPage();
    const panel = (await screen.findAllByRole("region", { name: "Ticket Details" }))[0]!;
    expect(within(panel).queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Mark as Resolved/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create Ticket/ })).not.toBeInTheDocument();
  });
});
