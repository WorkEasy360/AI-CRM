import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QUICK_ADD_ITEMS, QuickAdd, permittedQuickAddItems } from "@/components/shell/quick-add";
import type { ActiveContext } from "@/lib/api/types";

const open = vi.fn();
vi.mock("@/components/shell/quick-create-provider", () => ({
  useQuickCreate: () => ({ open }),
}));

function active(permissions: Record<string, "own" | "team" | "all">): ActiveContext {
  return {
    membership_id: "m1",
    organization: {
      id: "o1",
      name: "Acme",
      slug: "acme",
      base_currency: "USD",
      timezone: "UTC",
      plan: "trial",
      status: "active",
      require_mfa: false,
      created_at: "2026-01-01T00:00:00Z",
    },
    role: { key: "sales_rep", name: "Sales rep" },
    permissions,
    mfa_required: false,
  };
}

describe("QuickAdd", () => {
  beforeEach(() => open.mockReset());

  it("offers the seven create targets in order", () => {
    expect(QUICK_ADD_ITEMS.map((i) => i.label)).toEqual(["Contact", "Company", "Deal", "Task", "Call", "Meeting", "Ticket"]);
  });

  it("shows only the permitted items and opens the quick-create dialog", async () => {
    const user = userEvent.setup();
    render(<QuickAdd active={active({ "contacts.create": "own", "activities.create": "own" })} />);

    await user.click(screen.getByRole("button", { name: "New record" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent?.trim())).toEqual(["Contact", "Task", "Call", "Meeting"]);

    await user.click(screen.getByRole("menuitem", { name: "Call" }));
    expect(open).toHaveBeenCalledWith("call");
  });

  it("renders nothing when the member cannot create anything", () => {
    render(<QuickAdd active={active({ "contacts.view": "own" })} />);
    expect(screen.queryByRole("button", { name: "New record" })).not.toBeInTheDocument();
  });

  it("keeps a requested subset in the order asked for, permitted items only", () => {
    const subset = ["task", "call", "contact", "deal"] as const;
    const ctx = active({ "contacts.create": "own", "deals.create": "own", "activities.create": "own" });
    expect(permittedQuickAddItems(ctx, subset).map((i) => i.kind)).toEqual(["task", "call", "contact", "deal"]);
    expect(permittedQuickAddItems(active({ "deals.create": "own" }), subset).map((i) => i.kind)).toEqual(["deal"]);
  });
});
