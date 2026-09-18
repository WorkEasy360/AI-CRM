import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MembersPage, memberActions } from "@/components/settings/members-page";
import { ToastProvider } from "@/components/ui/toast";
import type { Invitation, Membership, Session } from "@/lib/api/types";

const perms = vi.hoisted(() => ({ role: "admin", permissions: {} as Record<string, string> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/settings/users",
}));

vi.mock("@/components/reauth-provider", () => ({
  useReauth: () => ({ runSensitive: <T,>(fn: () => Promise<T>) => fn() }),
  isReauthCancelled: () => false,
}));

vi.mock("@/lib/roles", () => ({ useRoles: () => ({ roles: [], isPending: false }) }));

vi.mock("@/lib/api/endpoints", () => ({
  listMembers: vi.fn(),
  listInvitations: vi.fn(),
  listTeams: vi.fn(),
  updateMemberRole: vi.fn(),
  suspendMember: vi.fn(),
  reactivateMember: vi.fn(),
  removeMember: vi.fn(),
  revokeMemberSessions: vi.fn(),
  setMemberTeams: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  createInvitation: vi.fn(),
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    useSession: () => ({
      data: { active: { membership_id: "me", role: { key: perms.role, name: perms.role }, permissions: perms.permissions } } as unknown as Session,
    }),
  };
});

import { listInvitations, listMembers, listTeams, removeMember, resendInvitation } from "@/lib/api/endpoints";

const ADMIN_PERMS = {
  "members.view": "all",
  "members.invite": "all",
  "members.update_role": "all",
  "members.disable": "all",
  "members.remove": "all",
  "teams.manage": "all",
};

function member(overrides: Partial<Membership> & { id: string; email: string }): Membership {
  const { email, ...rest } = overrides;
  return {
    user: { id: `u-${rest.id}`, email, display_name: email.split("@")[0] },
    role: { key: "sales_rep", name: "Sales Representative" },
    status: "active",
    display_status: "active",
    teams: [],
    mfa_enabled: false,
    last_login: null,
    joined_at: "2026-09-01T00:00:00Z",
    last_active_at: null,
    created_at: "2026-09-01T00:00:00Z",
    ...rest,
  } as Membership;
}

const ME = member({ id: "me", email: "owner@example.com", role: { key: "admin", name: "Admin" }, mfa_enabled: true, last_login: "2026-09-16T10:00:00Z" });
const REP = member({ id: "m2", email: "rep@example.com", teams: [{ id: "t1", name: "Inside Sales" }] });
const PAUSED = member({ id: "m3", email: "paused@example.com", status: "suspended", display_status: "suspended" });
const GONE = member({ id: "m4", email: "gone@example.com", status: "disabled", display_status: "disabled" });
const MEMBERS: Membership[] = [ME, REP, PAUSED, GONE];

const INVITE = {
  id: "i1",
  email: "invitee@example.com",
  name: "Invited Person",
  role: { key: "viewer", name: "Viewer" },
  team: null,
  status: "pending",
  expires_at: "2026-09-24T00:00:00Z",
  invited_by: { id: "u-me", email: "owner@example.com", display_name: "Owner" },
  send_count: 1,
  last_sent_at: "2026-09-17T00:00:00Z",
  created_at: "2026-09-17T00:00:00Z",
} as Invitation;

const page = <T,>(results: T[]) => ({ next: null, previous: null, results });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MembersPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("MembersPage (Users & Teams)", () => {
  beforeEach(() => {
    perms.role = "admin";
    perms.permissions = ADMIN_PERMS;
    vi.mocked(listMembers).mockReset().mockResolvedValue(page(MEMBERS));
    vi.mocked(listInvitations).mockReset().mockResolvedValue(page([INVITE]));
    vi.mocked(listTeams).mockReset().mockResolvedValue(page([]));
    vi.mocked(removeMember).mockReset();
    vi.mocked(resendInvitation).mockReset();
  });

  it("lists users and pending invitations with role, team, status, MFA and last login", async () => {
    renderPage();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Invited Person")).toBeInTheDocument();
    expect(within(table).getByText("Invited")).toBeInTheDocument();
    expect(within(table).getByText("Inside Sales")).toBeInTheDocument();
    expect(within(table).getByText("Suspended")).toBeInTheDocument();
    expect(within(table).getByText("Disabled")).toBeInTheDocument();
    expect(within(table).getByText("On")).toBeInTheDocument();
    expect(within(table).getAllByText("Never").length).toBeGreaterThan(0);
    for (const header of ["Name", "Email", "Role", "Team", "Status", "MFA", "Last login", "Joined"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Invite user/ })).toBeInTheDocument();
    // no actions on yourself or on removed users
    expect(screen.queryByRole("button", { name: "Actions for owner@example.com" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for gone@example.com" })).not.toBeInTheDocument();
  });

  it("removes a user after confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(removeMember).mockResolvedValue(REP);
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Actions for rep@example.com" }));
    await user.click(await screen.findByRole("menuitem", { name: /Remove user/ }));
    expect(await screen.findByText(/loses access immediately/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove user" }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith("m2"));
  });

  it("resends an invitation", async () => {
    const user = userEvent.setup();
    vi.mocked(resendInvitation).mockResolvedValue(INVITE);
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Actions for invitation to invitee@example.com" }));
    await user.click(await screen.findByRole("menuitem", { name: /Resend invitation/ }));
    await waitFor(() => expect(resendInvitation).toHaveBeenCalledWith("i1"));
  });

  it("offers no management actions to members without permission", async () => {
    perms.role = "sales_manager";
    perms.permissions = { "members.view": "all" };
    renderPage();
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: /Invite user/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  it("does not let an admin act on an owner", async () => {
    vi.mocked(listMembers).mockResolvedValue(page([member({ id: "o2", email: "boss@example.com", role: { key: "owner", name: "Owner" } })]));
    renderPage();
    await screen.findByText("boss@example.com", { selector: "td" });
    expect(screen.queryByRole("button", { name: "Actions for boss@example.com" })).not.toBeInTheDocument();
  });
});

describe("memberActions", () => {
  const all = { canUpdateRole: true, canSuspend: true, canRemove: true, canManageTeams: true, removed: false };

  it("offers suspend for active users and reactivate for suspended ones", () => {
    expect(memberActions(REP, all)).toEqual(["role", "teams", "sessions", "suspend", "remove"]);
    expect(memberActions(PAUSED, all)).toEqual(["role", "teams", "sessions", "reactivate", "remove"]);
  });

  it("offers nothing for removed users or without permissions", () => {
    expect(memberActions(GONE, { ...all, removed: true })).toEqual([]);
    expect(memberActions(REP, { canUpdateRole: false, canSuspend: false, canRemove: false, canManageTeams: false, removed: false })).toEqual([]);
  });
});
