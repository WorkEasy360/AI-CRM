import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContactOverview } from "@/components/crm/contacts/contact-overview";
import { Wordmark } from "@/components/shell/nav";
import type { Contact } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({ listDeals: vi.fn(), listRecordActivities: vi.fn() }));
import { listDeals, listRecordActivities } from "@/lib/api/crm";

let permissions: Record<string, string> = {};
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: { active: { membership_id: "m1", permissions } } as unknown as Session }) };
});

const CONTACT = { id: "c1", display_name: "Rahul Sharma" } as Contact;

function renderOverview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ContactOverview contact={CONTACT} newDealHref="/pipeline?new=1&contact=c1" />
    </QueryClientProvider>,
  );
}

describe("ContactOverview", () => {
  it("shows the open deal and the latest activities", async () => {
    permissions = { "deals.view": "all", "activities.view": "all" };
    vi.mocked(listDeals).mockResolvedValue({
      next: null,
      previous: null,
      results: [
        {
          id: "d1",
          name: "WhatsApp API Setup",
          amount: "150000.00",
          currency: "INR",
          probability: 60,
          expected_close_date: "2026-11-15",
          pipeline: { id: "p1", name: "Sales" },
          stage: { id: "s1", name: "Proposal" },
        },
      ],
    } as never);
    vi.mocked(listRecordActivities).mockResolvedValue({
      next: null,
      previous: null,
      results: [{ id: "a1", kind: "call", title: "Call with Rahul", status: "completed", start_at: "2026-11-04T11:30:00Z", completed_at: "2026-11-04T11:30:00Z" }],
    } as never);
    renderOverview();

    const deal = await screen.findByRole("region", { name: "Deal Details" });
    expect(await within(deal).findByRole("link", { name: "WhatsApp API Setup" })).toHaveAttribute("href", "/deals/d1");
    expect(within(deal).getByText("Sales")).toBeInTheDocument();
    expect(within(deal).getByText("60%")).toBeInTheDocument();
    expect(listDeals).toHaveBeenCalledWith({ contact: "c1", status: "open", sort: "-updated_at", limit: "1" });

    const recent = screen.getByRole("region", { name: "Recent Activities" });
    expect(await within(recent).findByText("Call with Rahul")).toBeInTheDocument();
  });

  it("leaves out what the role cannot see", () => {
    permissions = {};
    renderOverview();
    expect(screen.queryByRole("region", { name: "Deal Details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recent Activities" })).not.toBeInTheDocument();
  });
});

describe("Wordmark", () => {
  it("uses the workspace's CRM name and logo from General settings", () => {
    render(<Wordmark organization={{ name: "Digisoft", crm_name: "Digisoft CRM", logo_url: "/api/v1/organizations/current/logo/?v=abc" }} />);
    const link = screen.getByRole("link", { name: "Digisoft CRM home" });
    expect(within(link).getByText("Digisoft CRM")).toBeInTheDocument();
    expect(link.querySelector("img")).toHaveAttribute("src", "/api/v1/organizations/current/logo/?v=abc");
  });

  it("falls back to WorkEasy with the CRM pill", () => {
    render(<Wordmark />);
    expect(screen.getByRole("link", { name: "WorkEasyCRM home" })).toBeInTheDocument();
  });
});
