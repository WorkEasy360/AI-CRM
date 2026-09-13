import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyFormDialog } from "@/components/crm/companies/company-form-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  createCompany: vi.fn(),
  updateCompany: vi.fn(),
  getCompany: vi.fn(),
  listCustomFields: vi.fn(),
  findCompanyDuplicates: vi.fn(),
}));

const SESSION = {
  active: {
    membership_id: "m1",
    organization: { base_currency: "USD" },
    permissions: { "companies.create": "own", "companies.update": "own" },
  },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { createCompany, findCompanyDuplicates, listCustomFields } from "@/lib/api/crm";

const EMPTY_PAGE = { next: null, previous: null, results: [] };

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CompanyFormDialog open onOpenChange={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("CompanyFormDialog", () => {
  beforeEach(() => {
    vi.mocked(createCompany).mockReset();
    vi.mocked(listCustomFields).mockReset().mockResolvedValue(EMPTY_PAGE);
    vi.mocked(findCompanyDuplicates).mockReset().mockResolvedValue({ results: [] });
  });

  it("requires a name and validates the revenue currency client-side", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /More details/ }));
    await user.type(screen.getByLabelText("Revenue currency"), "us");
    await user.click(screen.getByRole("button", { name: "Create company" }));

    expect(await screen.findByText("Company name is required.")).toBeInTheDocument();
    expect(screen.getByText("Use a 3-letter currency code, e.g. USD.")).toBeInTheDocument();
    expect(createCompany).not.toHaveBeenCalled();
  });

  it("maps API field errors onto the form", async () => {
    const user = userEvent.setup();
    vi.mocked(createCompany).mockRejectedValue(
      new ApiError({
        type: "validation_error",
        title: "Invalid request",
        status: 400,
        errors: [{ field: "website", code: "invalid", message: "Enter a valid URL." }],
      }),
    );
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.type(screen.getByLabelText("Website"), "acme");
    await user.click(screen.getByRole("button", { name: "Create company" }));

    expect(await screen.findByText("Enter a valid URL.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Website")).toHaveAttribute("aria-invalid", "true"));
  });

  it("submits the expected payload", async () => {
    const user = userEvent.setup();
    vi.mocked(createCompany).mockResolvedValue({ id: "co1", name: "Acme" } as never);
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "Acme");
    await user.type(screen.getByLabelText("Website"), "https://acme.test");
    await user.click(screen.getByRole("button", { name: /More details/ }));
    await user.type(screen.getByLabelText("Annual revenue"), "1500000");
    await user.type(screen.getByLabelText("Revenue currency"), "eur");
    await user.click(screen.getByRole("button", { name: "Create company" }));

    await waitFor(() => expect(createCompany).toHaveBeenCalledTimes(1));
    expect(createCompany).toHaveBeenCalledWith({
      name: "Acme",
      website: "https://acme.test",
      phone: "",
      industry: "",
      company_size: "",
      annual_revenue: "1500000",
      revenue_currency: "EUR",
      source: "",
      address: {},
      description: "",
      custom_data: {},
      lifecycle_stage: "lead",
    });
  });
});
