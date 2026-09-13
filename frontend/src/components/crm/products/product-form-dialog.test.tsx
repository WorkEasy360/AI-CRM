import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductFormDialog } from "@/components/crm/products/product-form-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  getProduct: vi.fn(),
  listCustomFields: vi.fn(),
}));

const SESSION = {
  active: {
    membership_id: "m1",
    organization: { base_currency: "USD" },
    permissions: { "products.create": "own", "products.update": "own" },
  },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { createProduct, listCustomFields } from "@/lib/api/crm";

const EMPTY_PAGE = { next: null, previous: null, results: [] };

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ProductFormDialog open onOpenChange={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ProductFormDialog", () => {
  beforeEach(() => {
    vi.mocked(createProduct).mockReset();
    vi.mocked(listCustomFields).mockReset().mockResolvedValue(EMPTY_PAGE);
  });

  it("requires a name and a well-formed price client-side", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Unit price"), "abc");
    await user.type(screen.getByLabelText("Tax rate (%)"), "150");
    await user.click(screen.getByRole("button", { name: "Create product" }));

    expect(await screen.findByText("Product name is required.")).toBeInTheDocument();
    expect(screen.getByText("Enter a price with up to two decimals.")).toBeInTheDocument();
    expect(screen.getByText("Tax rate must be between 0 and 100.")).toBeInTheDocument();
    expect(createProduct).not.toHaveBeenCalled();
  });

  it("maps API field errors onto the form", async () => {
    const user = userEvent.setup();
    vi.mocked(createProduct).mockRejectedValue(
      new ApiError({
        type: "validation_error",
        title: "Invalid request",
        status: 400,
        errors: [{ field: "sku", code: "invalid", message: "Use letters, digits and dashes only." }],
      }),
    );
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "Widget");
    await user.type(screen.getByLabelText("SKU"), "bad sku!");
    await user.click(screen.getByRole("button", { name: "Create product" }));

    expect(await screen.findByText("Use letters, digits and dashes only.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("SKU")).toHaveAttribute("aria-invalid", "true"));
  });

  it("submits the expected payload with the organisation base currency", async () => {
    const user = userEvent.setup();
    vi.mocked(createProduct).mockResolvedValue({ id: "p1", name: "Widget" } as never);
    renderDialog();

    expect(screen.getByLabelText("Currency")).toHaveValue("USD");

    await user.type(screen.getByLabelText("Name"), "Widget");
    await user.type(screen.getByLabelText("Unit price"), "19.99");
    await user.click(screen.getByRole("button", { name: "Create product" }));

    await waitFor(() => expect(createProduct).toHaveBeenCalledTimes(1));
    expect(createProduct).toHaveBeenCalledWith({
      name: "Widget",
      sku: "",
      tax_label: "",
      status: "active",
      description: "",
      custom_data: {},
      unit_price: "19.99",
      currency: "USD",
    });
  });
});
