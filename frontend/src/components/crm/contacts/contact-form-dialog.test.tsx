import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactFormDialog } from "@/components/crm/contacts/contact-form-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  createContact: vi.fn(),
  updateContact: vi.fn(),
  getContact: vi.fn(),
  listCompanies: vi.fn(),
  listCustomFields: vi.fn(),
  findContactDuplicates: vi.fn(),
}));

const SESSION = {
  active: {
    membership_id: "m1",
    organization: { base_currency: "USD" },
    permissions: { "contacts.create": "own", "contacts.update": "own" },
  },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { createContact, findContactDuplicates, listCompanies, listCustomFields } from "@/lib/api/crm";

const EMPTY_PAGE = { next: null, previous: null, results: [] };

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ContactFormDialog open onOpenChange={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// jsdom lacks ResizeObserver, which the Radix Switch (WhatsApp consent) uses for sizing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("ContactFormDialog", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  beforeEach(() => {
    vi.mocked(createContact).mockReset();
    vi.mocked(listCompanies).mockReset().mockResolvedValue(EMPTY_PAGE);
    vi.mocked(listCustomFields).mockReset().mockResolvedValue(EMPTY_PAGE);
    vi.mocked(findContactDuplicates).mockReset().mockResolvedValue({ results: [] });
  });

  it("keeps the optional fields behind “More details” on create", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByLabelText("Job title")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /More details/ }));
    expect(screen.getByLabelText("Job title")).toBeInTheDocument();
    expect(screen.getByLabelText("Contact agreed to receive WhatsApp messages")).toBeInTheDocument();
  });

  it("rejects a malformed email client-side without calling the API", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Create contact" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(createContact).not.toHaveBeenCalled();
  });

  it("requires a name or an email", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Create contact" }));

    expect(await screen.findByText("Provide a first name, last name or email.")).toBeInTheDocument();
    expect(createContact).not.toHaveBeenCalled();
  });

  it("maps API field errors onto the form", async () => {
    const user = userEvent.setup();
    vi.mocked(createContact).mockRejectedValue(
      new ApiError({
        type: "validation_error",
        title: "Invalid request",
        status: 400,
        errors: [{ field: "email", code: "unique", message: "A contact with this email already exists." }],
      }),
    );
    renderDialog();

    await user.type(screen.getByLabelText("First name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Create contact" }));

    expect(await screen.findByText("A contact with this email already exists.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true"));
  });

  it("submits the expected payload", async () => {
    const user = userEvent.setup();
    vi.mocked(createContact).mockResolvedValue({
      id: "c1",
      display_name: "Ada Lovelace",
      email: "ada@example.com",
    } as never);
    renderDialog();

    await user.type(screen.getByLabelText("First name"), "Ada");
    await user.type(screen.getByLabelText("Last name"), "Lovelace");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: /More details/ }));
    await user.type(screen.getByLabelText("City"), "London");
    await user.click(screen.getByRole("button", { name: "Create contact" }));

    await waitFor(() => expect(createContact).toHaveBeenCalledTimes(1));
    expect(createContact).toHaveBeenCalledWith({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      phone: "",
      job_title: "",
      company_id: null,
      source: "",
      address: { city: "London" },
      description: "",
      custom_data: {},
      lifecycle_stage: "lead",
      whatsapp_opt_in: false,
    });
  });
});
