import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DealFormDialog } from "@/components/crm/deals/deal-form-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { Deal, Pipeline } from "@/lib/api/crm-types";
import type { RoleRef, Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  listCompanies: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listContacts: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listCustomFields: vi.fn(async () => ({ next: null, previous: null, results: [] })),
}));

vi.mock("@/lib/api/endpoints", () => ({
  listMembers: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  getSession: vi.fn(),
}));

const session: Session = {
  user: { id: "u1", email: "ada@example.com", display_name: "Ada" } as Session["user"],
  mfa_enabled: false,
  recently_authenticated: true,
  memberships: [],
  active: {
    membership_id: "m1",
    organization: { id: "o1", name: "Keel", slug: "keel", base_currency: "USD", timezone: "UTC", plan: "free", status: "active", require_mfa: false, created_at: "2026-01-01T00:00:00Z" },
    role: { key: "sales_rep", name: "Sales Rep" } as RoleRef,
    permissions: { "deals.create": "own", "deals.update": "own" },
    mfa_required: false,
  },
};

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: session }) };
});

import { createDeal, updateDeal } from "@/lib/api/crm";

const pipelines: Pipeline[] = [
  {
    id: "p1",
    name: "Sales",
    position: 1,
    is_default: true,
    version: 1,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    stages: [
      { id: "s1", pipeline_id: "p1", name: "Qualified", position: 1, kind: "open", default_probability: 20, description: "", color_token: "blue", archived_at: null },
      { id: "s2", pipeline_id: "p1", name: "Won", position: 2, kind: "won", default_probability: 100, description: "", color_token: "green", archived_at: null },
      { id: "s3", pipeline_id: "p1", name: "Lost", position: 3, kind: "lost", default_probability: 0, description: "", color_token: "red", archived_at: null },
    ],
  },
];

const existingDeal: Deal = {
  id: "d1",
  name: "Acme renewal",
  owner: { id: "m1", display_name: "Ada" },
  tags: [],
  custom_data: {},
  version: 7,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  pipeline: { id: "p1", name: "Sales" },
  stage: { id: "s1", name: "Qualified", kind: "open", color_token: "blue" },
  company: null,
  primary_contact: null,
  amount: "900.00",
  currency: "EUR",
  exchange_rate: "1.08000000",
  amount_base: "972.00",
  probability: 20,
  expected_close_date: null,
  status: "open",
  closed_at: null,
  lost_reason: "",
  stage_entered_at: "2026-01-02T00:00:00Z",
  description: "",
  line_count: 0,
  products_total: null,
};

function renderDialog(props: Partial<React.ComponentProps<typeof DealFormDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DealFormDialog open onOpenChange={onOpenChange} pipelines={pipelines} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe("DealFormDialog", () => {
  beforeEach(() => {
    vi.mocked(createDeal).mockReset();
    vi.mocked(updateDeal).mockReset();
  });

  it("requires a name and a well-formed amount before calling the API", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "12.345");
    await user.click(screen.getByRole("button", { name: "Create deal" }));

    expect(await screen.findByText("Deal name is required.")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount like 1500 or 1500.50.")).toBeInTheDocument();
    expect(screen.getByLabelText("Deal name")).toHaveAttribute("aria-invalid", "true");
    expect(createDeal).not.toHaveBeenCalled();
  });

  it("creates a deal with the default pipeline, base currency and nulls for empty relations", async () => {
    const user = userEvent.setup();
    vi.mocked(createDeal).mockResolvedValue({ ...existingDeal, id: "d9", name: "Globex pilot" });
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("Deal name"), "Globex pilot");
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "1500");
    await user.type(screen.getByLabelText("Probability (%)"), "40");
    await user.type(screen.getByLabelText("Expected close"), "2026-12-31");
    await user.click(screen.getByRole("button", { name: "Create deal" }));

    await waitFor(() => expect(createDeal).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(createDeal).mock.calls[0]![0];
    expect(payload).toMatchObject({
      name: "Globex pilot",
      pipeline_id: "p1",
      amount: "1500",
      currency: "USD",
      probability: 40,
      expected_close_date: "2026-12-31",
      company_id: null,
      primary_contact_id: null,
      custom_data: {},
    });
    expect(payload).not.toHaveProperty("stage_id");
    expect(payload).not.toHaveProperty("exchange_rate");
    expect(payload).not.toHaveProperty("owner_id");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("sends the exchange rate only for foreign currencies and rejects a bad rate", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Deal name"), "Paris expansion");
    await user.clear(screen.getByLabelText("Currency"));
    await user.type(screen.getByLabelText("Currency"), "eur");
    const rate = await screen.findByLabelText("Rate to USD");
    await user.type(rate, "-2");
    await user.click(screen.getByRole("button", { name: "Create deal" }));
    expect(await screen.findByText("Enter a positive rate (up to 8 decimals).")).toBeInTheDocument();
    expect(createDeal).not.toHaveBeenCalled();

    vi.mocked(createDeal).mockResolvedValue(existingDeal);
    await user.clear(rate);
    await user.type(rate, "1.08");
    await user.click(screen.getByRole("button", { name: "Create deal" }));
    await waitFor(() => expect(createDeal).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createDeal).mock.calls[0]![0]).toMatchObject({ currency: "EUR", exchange_rate: "1.08" });
  });

  it("edits with the record version and never sends pipeline or stage", async () => {
    const user = userEvent.setup();
    vi.mocked(updateDeal).mockResolvedValue({ ...existingDeal, version: 8 });
    renderDialog({ deal: existingDeal });

    expect(screen.queryByLabelText("Pipeline")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Deal name")).toHaveValue("Acme renewal");
    expect(screen.getByLabelText("Rate to USD")).toHaveValue("1.08000000");

    await user.clear(screen.getByLabelText("Deal name"));
    await user.type(screen.getByLabelText("Deal name"), "Acme renewal 2027");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateDeal).toHaveBeenCalledTimes(1));
    const [id, version, payload] = vi.mocked(updateDeal).mock.calls[0]!;
    expect(id).toBe("d1");
    expect(version).toBe(7);
    expect(payload).toMatchObject({ name: "Acme renewal 2027", currency: "EUR", exchange_rate: "1.08000000", probability: 20 });
    expect(payload).not.toHaveProperty("pipeline_id");
    expect(payload).not.toHaveProperty("stage_id");
    expect(createDeal).not.toHaveBeenCalled();
  });
});
