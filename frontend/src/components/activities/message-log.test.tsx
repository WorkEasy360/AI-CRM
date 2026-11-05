import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageLog } from "@/components/activities/message-log";
import type { WhatsAppMessage } from "@/lib/api/crm-types";

vi.mock("@/lib/api/crm", () => ({ listWhatsAppInbox: vi.fn(), listEmailInbox: vi.fn() }));
import { listEmailInbox, listWhatsAppInbox } from "@/lib/api/crm";

function wa(overrides: Partial<WhatsAppMessage>): WhatsAppMessage {
  return {
    id: "w1",
    direction: "outbound",
    status: "sent",
    wa_id: "919876543210",
    message_type: "text",
    body: "Hi Rahul, sharing the proposal",
    template: null,
    template_params: [],
    contact: { id: "c1", name: "Rahul Sharma" },
    deal: null,
    sent_by: { id: "m1", display_name: "Manoj Kumar" } as WhatsAppMessage["sent_by"],
    sent_at: "2026-11-04T10:15:00Z",
    received_at: null,
    error_message: "",
    ai_assisted: false,
    created_at: "2026-11-04T10:15:00Z",
    ...overrides,
  };
}

function renderLog(channel: "whatsapp" | "email") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MessageLog channel={channel} />
    </QueryClientProvider>,
  );
}

describe("MessageLog", () => {
  it("lists WhatsApp conversations with who they relate to and their status", async () => {
    vi.mocked(listWhatsAppInbox).mockResolvedValue({
      next: null,
      previous: null,
      results: [wa({}), wa({ id: "w2", direction: "inbound", status: "received", body: "Thanks!", sent_by: null })],
    });
    renderLog("whatsapp");
    const table = await screen.findByRole("table", { name: /WhatsApp messages, newest first/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Rahul Sharma" })).toHaveAttribute("href", "/contacts/c1");
    expect(within(rows[0]!).getByText("Manoj Kumar")).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText("Sent")).toBeInTheDocument();
    expect(within(rows[1]!).getByLabelText("Received")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Customer")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("received")).toBeInTheDocument();
    expect(listWhatsAppInbox).toHaveBeenCalled();
  });

  it("shows an empty state when there are no emails", async () => {
    vi.mocked(listEmailInbox).mockResolvedValue({ next: null, previous: null, results: [] });
    renderLog("email");
    expect(await screen.findByText("No emails yet")).toBeInTheDocument();
  });
});
