import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuickActions } from "@/components/crm/quick-actions";
import type { Deal } from "@/lib/api/crm-types";
import type { RoleRef, Session } from "@/lib/api/types";

vi.mock("@/components/messaging/whatsapp-dialog", () => ({
  WhatsAppDialog: ({ open, contact }: { open: boolean; contact: { phone: string; name: string } }) =>
    open ? <div role="dialog" aria-label="WhatsApp message">{`${contact.name} ${contact.phone}`}</div> : null,
}));
vi.mock("@/components/messaging/email-composer-dialog", () => ({ EmailComposerDialog: () => null }));
vi.mock("@/components/activities/activity-form-dialog", () => ({ ActivityFormDialog: () => null }));
vi.mock("@/components/crm/quick-note-dialog", () => ({ QuickNoteDialog: () => null }));

const permissions: Record<string, "own" | "team" | "all"> = { "whatsapp.send": "all", "email.send": "all", "activities.create": "own" };
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  const session = (): Session => ({
    user: { id: "u1", email: "ada@example.com", display_name: "Ada" } as Session["user"],
    mfa_enabled: false,
    recently_authenticated: true,
    memberships: [],
    active: {
      membership_id: "m1",
      organization: { id: "o1", name: "Keel", slug: "keel", base_currency: "USD", timezone: "UTC", plan: "free", status: "active", require_mfa: false, created_at: "2026-01-01T00:00:00Z" },
      role: { key: "sales_rep", name: "Sales Rep" } as RoleRef,
      permissions,
      mfa_required: false,
    },
  });
  return { ...actual, useSession: () => ({ data: session() }) };
});

const deal: Deal = {
  id: "d1",
  name: "Acme renewal",
  owner: { id: "m1", display_name: "Ada" },
  tags: [],
  custom_data: {},
  version: 1,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  pipeline: { id: "p1", name: "Sales" },
  stage: { id: "s1", name: "Proposal", kind: "open", color_token: "teal" },
  company: { id: "c1", name: "Acme" },
  primary_contact: { id: "k1", name: "Hank Scorpio", email: "hank@acme.test", phone: "+1 555 0100", whatsapp_opt_in: true },
  amount: "12000.00",
  currency: "USD",
  exchange_rate: "1",
  amount_base: "12000.00",
  probability: 50,
  expected_close_date: "2026-09-30",
  status: "open",
  closed_at: null,
  lost_reason: "",
  stage_entered_at: "2026-09-01T00:00:00Z",
  description: "",
  line_count: 0,
  probability_overridden: false,
  weighted_amount_base: "6000.00",
  last_activity_at: null,
  next_activity_at: null,
  next_activity_title: "",
  risk_level: "low",
  contact_count: 1,
  products_total: null,
};

describe("QuickActions on a deal", () => {
  it("offers WhatsApp from the deal header using the primary contact's permitted phone", async () => {
    const user = userEvent.setup();
    render(<QuickActions deal={deal} />);
    await user.click(screen.getByRole("button", { name: "WhatsApp" }));
    expect(screen.getByRole("dialog", { name: "WhatsApp message" })).toHaveTextContent("Hank Scorpio +1 555 0100");
  });

  it("hides WhatsApp when the deal payload carries no phone (contact outside the member's scope)", () => {
    render(<QuickActions deal={{ ...deal, primary_contact: { id: "k1", name: "Hank Scorpio", email: "hank@acme.test", phone: null, whatsapp_opt_in: null } }} />);
    expect(screen.queryByRole("button", { name: "WhatsApp" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email" })).toBeInTheDocument();
  });
});
