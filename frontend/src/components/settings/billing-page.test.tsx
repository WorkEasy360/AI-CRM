import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BillingPage } from "@/components/settings/billing-page";
import { ToastProvider } from "@/components/ui/toast";
import type { EditionCatalog, Subscription, UsageMetric } from "@/lib/api/billing";
import type { Session } from "@/lib/api/types";

const metric = (key: string, label: string): UsageMetric => ({
  key,
  label,
  period: "count",
  unit: "count",
  used: 3,
  limit: 10,
  addon_amount: 0,
  modules: null,
  state: "ok",
  upgrade_edition: null,
  addon: null,
});

const CATALOG: EditionCatalog = {
  editions: [
    {
      key: "express",
      name: "Express",
      rank: 1,
      tagline: "",
      price_monthly_cents: 900,
      price_annual_cents: 700,
      limits: {},
      features: ["payment_links", "whatsapp"],
    },
  ],
  features: [
    { key: "payment_links", label: "Payment links" },
    { key: "whatsapp", label: "WhatsApp integration" },
  ],
  metrics: [],
  addons: [
    { key: "extra_records", label: "5,000 extra records", metric: "records", feature: null, unit_amount: 5000, price_cents: 500, recurring: true },
    { key: "data_backup", label: "Scheduled data backup", metric: null, feature: "data_backup", unit_amount: 0, price_cents: 300, recurring: true },
  ],
};

const SUBSCRIPTION: Subscription = {
  edition: { key: "express", name: "Express" },
  subscribed_edition: "express",
  status: "active",
  billing_cycle: "monthly",
  seats: 1,
  seat_limit: 1,
  trial_ends_at: null,
  current_period_end: null,
  grandfathered: false,
  features: [],
  self_service: true,
};

vi.mock("@/lib/api/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/billing")>();
  return {
    ...actual,
    getEditionCatalog: vi.fn(async () => CATALOG),
    getSubscription: vi.fn(async () => SUBSCRIPTION),
    getUsage: vi.fn(async () => ({ edition: SUBSCRIPTION.edition, features: [], metrics: [metric("users", "Users"), metric("booking_pages", "Booking pages")] })),
    listAddonPurchases: vi.fn(async () => ({ results: [] })),
  };
});

const SESSION = { active: { membership_id: "m1", permissions: { "org.billing": "all" } } } as unknown as Session;
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <BillingPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("BillingPage upcoming features", () => {
  it("badges catalogue entries that are not built and keeps their controls disabled", async () => {
    renderPage();

    // A plan feature with no implementation is badged; a working one is not.
    const payment = await screen.findByText("Payment links");
    expect(within(payment.closest("li")!).getByText("Upcoming")).toBeInTheDocument();
    expect(within(screen.getByText("WhatsApp integration").closest("li")!).queryByText("Upcoming")).not.toBeInTheDocument();

    // A meter with no counter shows no figure, only the badge.
    expect(screen.getByRole("progressbar", { name: "Users usage" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Booking pages usage" })).not.toBeInTheDocument();

    // The add-on for a missing feature cannot be bought; a real one can.
    const rows = screen.getAllByRole("button", { name: "Add" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBeEnabled();
    expect(rows[1]).toBeDisabled();
  });
});
