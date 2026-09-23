import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PRIMARY_NAV, SETTINGS_NAV, SideNav, visibleSettingsNav } from "@/components/shell/nav";
import type { ActiveContext, Session } from "@/lib/api/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/contacts",
}));

// next/link never puts `prefetch` on the DOM node, so it is mirrored onto a data attribute here to
// keep the prefetching guarantee below testable. Everything else passes straight through.
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children: React.ReactNode }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

const organization = {
  id: "o1",
  name: "Acme",
  slug: "acme",
  base_currency: "USD",
  timezone: "UTC",
  plan: "trial",
  status: "active",
  require_mfa: false,
  created_at: "2026-01-01T00:00:00Z",
};

function active(permissions: Record<string, "own" | "team" | "all">, role = "sales_rep"): ActiveContext {
  return { membership_id: "m1", organization, role: { key: role, name: role }, permissions, mfa_required: false };
}

const REP = active({
  "contacts.view": "team",
  "contacts.create": "all",
  "deals.view": "team",
  "pipelines.view": "all",
  "customfields.view": "all",
  "tags.view": "all",
  "org.view": "all",
  "members.view": "all",
  "teams.view": "all",
  "email.view": "all",
  "whatsapp.view": "all",
});

const ADMIN = active(
  {
    "org.update": "all",
    "members.invite": "all",
    "teams.manage": "all",
    "pipelines.manage": "all",
    "customfields.manage": "all",
    "tags.manage": "all",
    "contacts.export": "all",
    "audit.view": "all",
    "email.view": "all",
    "whatsapp.view": "all",
    "ai.settings.manage": "all",
    "integrations.view": "all",
  },
  "admin",
);

function session(ctx: ActiveContext): Session {
  return {
    user: { id: "u1", email: "rep@example.com", display_name: "Rae Rep" },
    mfa_enabled: false,
    recently_authenticated: true,
    memberships: [{ id: "m1", organization, role: ctx.role, status: "active" }],
    active: ctx,
  };
}

describe("navigation", () => {
  it("keeps the sidebar to the six CRM sections plus Settings and the profile", () => {
    render(<SideNav session={session(REP)} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent?.trim())).toEqual(["Dashboard", "Pipeline", "Contacts", "Companies", "Activities", "Products", "Settings", expect.stringContaining("Rae Rep")]);
    expect(within(nav).getByRole("link", { name: "Contacts" })).toHaveAttribute("aria-current", "page");
    for (const label of ["Organization", "Members", "Teams", "Custom fields", "Tags", "Audit log", "Reports"]) {
      expect(within(nav).queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
    expect(PRIMARY_NAV).toHaveLength(6);
  });

  /**
   * Performance regression guard. Every route renders dynamically, so the default `<Link>` prefetch
   * stops at the `loading.tsx` boundary and leaves the page's own chunk to load on click. React then
   * has to commit that skeleton, and a committed Suspense fallback is held for ~300 ms before it may
   * be replaced — which is exactly the navigation delay this prefetch removes (measured: content
   * painted at ~350 ms per hop before, ~53 ms after). Dropping `prefetch` here silently brings the
   * delay back, so it is asserted rather than left to a comment.
   */
  it("prefetches every primary destination in full so a click never waits on the route chunk", () => {
    render(<SideNav session={session(REP)} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const item of PRIMARY_NAV) {
      expect(within(nav).getByRole("link", { name: item.label })).toHaveAttribute("data-prefetch", "true");
    }
    expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute("data-prefetch", "true");
  });

  it("shows a sales representative only their personal settings pages", () => {
    expect(visibleSettingsNav(REP).map((i) => i.label)).toEqual(["Email", "WhatsApp", "Notifications", "Security"]);
  });

  it("shows an administrator every settings page they can act on", () => {
    expect(visibleSettingsNav(ADMIN).map((i) => i.label)).toEqual(SETTINGS_NAV.map((i) => i.label));
    expect(SETTINGS_NAV.map((i) => i.href)).toEqual([
      "/settings/general",
      "/settings/users",
      "/settings/pipelines",
      "/settings/custom-fields",
      "/settings/tags",
      "/settings/email",
      "/settings/whatsapp",
      "/settings/notifications",
      "/settings/ai",
      "/settings/integrations",
      "/settings/security",
      "/settings/data",
      "/settings/audit-log",
    ]);
  });

  it("keeps integration administration out of the sales sidebar and inside Settings", () => {
    render(<SideNav session={session(ADMIN)} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByRole("link", { name: "Integrations" })).not.toBeInTheDocument();
    expect(visibleSettingsNav(ADMIN).map((i) => i.label)).toContain("Integrations");
    expect(visibleSettingsNav(REP).map((i) => i.label)).not.toContain("Integrations");
  });

  it("falls back to the always-visible pages when there is no active organization", () => {
    expect(visibleSettingsNav(null).map((i) => i.label)).toEqual(["Notifications", "Security"]);
  });
});
