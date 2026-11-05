import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContactsPage } from "@/components/crm/contacts/contacts-page";
import { ToastProvider } from "@/components/ui/toast";
import type { Contact } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  listContacts: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  getContact: vi.fn(),
  listCompanies: vi.fn(),
  listCustomFields: vi.fn(),
  findContactDuplicates: vi.fn(),
  listTags: vi.fn(),
  archiveRecord: vi.fn(),
  restoreRecord: vi.fn(),
  bulkAction: vi.fn(),
  contactStats: vi.fn(),
  setFavorite: vi.fn(),
  createCompany: vi.fn(),
  setRecordTags: vi.fn(),
  createTag: vi.fn(),
}));

// Stable instances: useListParams memoises on the search params object, so a fresh one per render would loop.
const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() };
// The existing list is the Individuals tab; All Contacts (people + companies) is the default.
let searchParams = new URLSearchParams("tab=people");
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/contacts",
  useSearchParams: () => searchParams,
}));

const SESSION = {
  active: {
    membership_id: "m1",
    organization: { base_currency: "USD" },
    permissions: { "contacts.view": "all", "contacts.create": "own", "contacts.update": "own", "companies.view": "all", "companies.create": "own" },
  },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { contactStats, createContact, listCompanies, listContacts, listCustomFields, listTags } from "@/lib/api/crm";

const EMPTY_PAGE = { next: null, previous: null, results: [] };

function contact(overrides: Partial<Contact> & Pick<Contact, "id" | "first_name" | "last_name">): Contact {
  return {
    display_name: `${overrides.first_name} ${overrides.last_name}`.trim(),
    email: "",
    phone: "",
    job_title: "",
    company: null,
    source: "",
    address: {},
    description: "",
    open_deal_count: 0,
    last_activity_at: null,
    next_activity_at: null,
    next_activity_title: "",
    lifecycle_stage: "lead",
    lifecycle_changed_at: null,
    whatsapp_opt_in: false,
    whatsapp_opt_in_at: null,
    lead_score: 0,
    owner: { id: "m1", display_name: "Ada Lovelace" },
    tags: [],
    custom_data: {},
    version: 1,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ContactsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("ContactsPage", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("tab=people");
    vi.mocked(listContacts).mockReset();
    vi.mocked(listCustomFields).mockReset().mockResolvedValue(EMPTY_PAGE);
    vi.mocked(listCompanies).mockReset().mockResolvedValue(EMPTY_PAGE);
    vi.mocked(listTags).mockReset().mockResolvedValue(EMPTY_PAGE);
    vi.mocked(contactStats).mockReset().mockResolvedValue({
      total: 862,
      with_open_deals: 0,
      without_deals: 0,
      untouched: 0,
      favorites: 20,
      tagged: 300,
      created: 59,
      created_previous: 50,
      days: 30,
      companies: { total: 386, favorites: 8, tagged: 20, created: 10, created_previous: 10 },
    });
  });

  it("shows All Contacts by default: people and companies with type pills and the header counts", async () => {
    searchParams = new URLSearchParams("");
    vi.mocked(listContacts).mockResolvedValue({
      next: null,
      previous: null,
      results: [contact({ id: "c1", first_name: "Rahul", last_name: "Sharma", phone: "+91 98710 27926", updated_at: "2026-11-05T10:00:00Z", tags: [{ id: "t1", name: "Real Estate", color_token: "pink" }] })],
    });
    vi.mocked(listCompanies).mockResolvedValue({
      next: null,
      previous: null,
      results: [{ id: "co1", name: "Zenith Group", phone: "", tags: [], updated_at: "2026-11-04T10:00:00Z", last_activity_at: null } as never],
    });
    renderPage();
    const nav = await screen.findByRole("navigation", { name: "Contacts views" });
    expect(await within(nav).findByRole("link", { name: /All Contacts \(1,248\)/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: /Individuals \(862\)/ })).toHaveAttribute("href", "/contacts?tab=people");
    expect(within(nav).getByRole("link", { name: /Favorites \(28\)/ })).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "Contacts list" });
    expect(await within(list).findByText("Rahul Sharma")).toBeInTheDocument();
    expect(within(list).getByText("Zenith Group", { selector: "span" })).toBeInTheDocument();
    expect(within(list).getByText("Individual")).toBeInTheDocument();
    expect(within(list).getByText("Company")).toBeInTheDocument();
    expect(within(list).getByText("Real Estate")).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "WhatsApp Rahul Sharma" })).toHaveAttribute("href", "/contacts/c1");
    expect(within(screen.getByRole("region", { name: "Contact summary" })).getByText("1,248")).toBeInTheDocument();
  });

  it("adds an individual with the +91 code, requiring a name and a phone", async () => {
    searchParams = new URLSearchParams("");
    vi.mocked(listContacts).mockResolvedValue(EMPTY_PAGE);
    vi.mocked(createContact).mockResolvedValue(contact({ id: "new", first_name: "Rahul", last_name: "Sharma" }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /Add Contact/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Individual" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save Contact" }));
    expect(within(dialog).getByText("Enter the person's full name.")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter a phone number.")).toBeInTheDocument();
    expect(createContact).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/Full Name/), "Rahul Kumar Sharma");
    await user.type(within(dialog).getByLabelText(/^Phone/), "98710 27926");
    await user.type(within(dialog).getByLabelText("Email"), "rahul@apextech.in");
    await user.click(within(dialog).getByRole("button", { name: "Save Contact" }));
    await vi.waitFor(() =>
      expect(createContact).toHaveBeenCalledWith({
        first_name: "Rahul",
        last_name: "Kumar Sharma",
        email: "rahul@apextech.in",
        phone: "+91 98710 27926",
        job_title: "",
        company_id: null,
        description: "",
      }),
    );
  });

  it("renders the new columns with lifecycle badges and activity cells", async () => {
    const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    vi.mocked(listContacts).mockResolvedValue({
      next: null,
      previous: null,
      results: [
        contact({
          id: "c1",
          first_name: "Grace",
          last_name: "Hopper",
          email: "grace@example.com",
          phone: "+1 555 0100",
          company: { id: "co1", name: "Acme" },
          lifecycle_stage: "customer",
          last_activity_at: "2026-01-01T00:00:00Z",
          next_activity_at: soon,
          next_activity_title: "Renewal call",
        }),
        contact({ id: "c2", first_name: "Linus", last_name: "T", lifecycle_stage: "inactive", owner: null }),
      ],
    });
    renderPage();

    const table = await screen.findByRole("table", { name: "Contacts" });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(["Name", "Company", "Email", "Phone", "Status", "Owner", "Last activity", "Next activity"]));

    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Grace Hopper" })).toHaveAttribute("href", "/contacts/c1");
    expect(within(rows[0]!).getByRole("link", { name: "Acme" })).toHaveAttribute("href", "/companies/co1");
    expect(within(rows[0]!).getByRole("link", { name: "grace@example.com" })).toHaveAttribute("href", "mailto:grace@example.com");
    expect(within(rows[0]!).getByText("Customer")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Renewal call")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Inactive")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Unassigned")).toBeInTheDocument();
  });

  it("offers a status filter and shows an empty state", async () => {
    const user = userEvent.setup();
    vi.mocked(listContacts).mockResolvedValue(EMPTY_PAGE);
    renderPage();

    expect(await screen.findByText("No contacts yet")).toBeInTheDocument();
    // The filters panel is collapsed until toggled; the status select lives inside it.
    expect(screen.queryByRole("combobox", { name: "Status filter" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    expect(screen.getByRole("combobox", { name: "Status filter" })).toHaveTextContent("All statuses");
  });
});
