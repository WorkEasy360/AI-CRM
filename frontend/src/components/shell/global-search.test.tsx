import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSearch, hitHref } from "@/components/shell/global-search";
import { ApiError, parseProblem } from "@/lib/api/problem";
import type { ActiveContext } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  globalSearch: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/dashboard",
}));

import { globalSearch } from "@/lib/api/crm";

const active: ActiveContext = {
  membership_id: "m1",
  organization: {
    id: "o1",
    name: "Acme",
    slug: "acme",
    base_currency: "USD",
    timezone: "UTC",
    plan: "free",
    status: "active",
    require_mfa: false,
    created_at: "2026-01-01T00:00:00Z",
  },
  role: { key: "admin", name: "Admin" },
  permissions: { "search.use": "all" },
  mfa_required: false,
};

function renderSearch(overrides: Partial<ActiveContext> = {}) {
  const onOpenChange = vi.fn();
  render(<GlobalSearch active={{ ...active, ...overrides }} open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

describe("GlobalSearch", () => {
  beforeEach(() => {
    vi.mocked(globalSearch).mockReset();
    push.mockReset();
  });

  it("calls the API once after the debounce and renders results as links", async () => {
    vi.mocked(globalSearch).mockResolvedValue({
      query: "ann",
      results: {
        contact: [{ id: "c1", type: "contact", title: "Ann Lee", subtitle: "ann@example.com", meta: "Acme" }],
        deal: [{ id: "d1", type: "deal", title: "Annual renewal", subtitle: "$12,000", meta: "Proposal" }],
      },
    });
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole("combobox", { name: "Search" }), "ann");

    await waitFor(() => expect(globalSearch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(globalSearch).mock.calls[0]?.[0]).toBe("ann");
    expect(vi.mocked(globalSearch).mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);

    const contact = await screen.findByRole("link", { name: /Ann Lee/ });
    expect(contact).toHaveAttribute("href", "/contacts/c1");
    expect(screen.getByRole("link", { name: /Annual renewal/ })).toHaveAttribute("href", "/deals/d1");
    expect(screen.getByText("Contacts")).toBeInTheDocument();
    expect(screen.getByText("Deals")).toBeInTheDocument();
    // Still only one request after rendering.
    expect(globalSearch).toHaveBeenCalledTimes(1);
  });

  it("navigates to the highlighted result on Enter", async () => {
    vi.mocked(globalSearch).mockResolvedValue({
      query: "acme",
      results: { company: [{ id: "co1", type: "company", title: "Acme Inc", subtitle: "", meta: "" }] },
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderSearch();

    await user.type(screen.getByRole("combobox", { name: "Search" }), "acme");
    await screen.findByRole("link", { name: /Acme Inc/ });
    await user.keyboard("{Enter}");

    expect(push).toHaveBeenCalledWith("/companies/co1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a friendly message on 403", async () => {
    vi.mocked(globalSearch).mockRejectedValue(new ApiError(parseProblem(403, { type: "permission_denied", title: "Not allowed", status: 403 })));
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole("combobox", { name: "Search" }), "ann");

    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to search.");
  });

  it("does not search below the minimum query length", async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole("combobox", { name: "Search" }), "a");
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(globalSearch).not.toHaveBeenCalled();
    expect(screen.getByText(/Type at least 2 characters/)).toBeInTheDocument();
  });

  it("renders nothing for members without search.use", () => {
    renderSearch({ permissions: {} });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });

  it("URL-encodes ids in result links", () => {
    expect(hitHref("product", "a b/c")).toBe("/products/a%20b%2Fc");
    expect(hitHref("activity", "a 1")).toBe("/activities?open=a%201");
  });

  it("groups activities after deals and links them to the Activities page", async () => {
    vi.mocked(globalSearch).mockResolvedValue({
      query: "demo",
      results: {
        product: [{ id: "p1", type: "product", title: "Demo kit", subtitle: "", meta: "" }],
        activity: [{ id: "a1", type: "activity", title: "Demo call", subtitle: "Tomorrow 10:00", meta: "Call" }],
        deal: [{ id: "d1", type: "deal", title: "Demo deal", subtitle: "", meta: "" }],
      },
    });
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole("combobox", { name: "Search" }), "demo");

    expect(await screen.findByRole("link", { name: /Demo call/ })).toHaveAttribute("href", "/activities?open=a1");
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Deals", "Activities", "Products"]);
  });
});
