import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "@/components/auth-gate";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError, parseProblem } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/endpoints", () => ({
  getSession: vi.fn(),
  bootstrapSession: vi.fn(),
  switchOrganization: vi.fn(),
}));

vi.mock("@/lib/api/allauth", () => ({ logout: vi.fn() }));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
  usePathname: () => "/contacts",
  useSearchParams: () => new URLSearchParams("view=all"),
}));

import { logout } from "@/lib/api/allauth";
import { bootstrapSession, getSession, switchOrganization } from "@/lib/api/endpoints";

const notAuthenticated = () => new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 }));

/** Fire whatever handler the gate registered, as a real 401 from any API call would. */
function unauthenticated(): void {
  registered?.(new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 })));
}

let registered: ((error: ApiError) => void) | null = null;
let accessEndedRegistered: ((error: ApiError) => void) | null = null;
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    setUnauthenticatedHandler: (handler: ((error: ApiError) => void) | null) => {
      registered = handler;
    },
    setAccessEndedHandler: (handler: ((error: ApiError) => void) | null) => {
      accessEndedRegistered = handler;
    },
  };
});

const ACCESS_ENDED_DETAIL = "Your organization's access to Easy CRM has ended. An owner can renew it in Workeasy360.";

/** What any API call answered 403 workeasy360_access_ended does (setAccessEndedHandler in the gate). */
function accessEnded(): void {
  act(() =>
    accessEndedRegistered?.(
      new ApiError(
        parseProblem(403, { type: "workeasy360_access_ended", title: "Forbidden", status: 403, detail: ACCESS_ENDED_DETAIL }),
      ),
    ),
  );
}

const organization = {
  id: "o1",
  name: "Ada's workspace",
  slug: "ada",
  base_currency: "USD",
  timezone: "UTC",
  plan: "trial",
  status: "active",
  require_mfa: false,
  created_at: "2026-01-01T00:00:00Z",
};

const withoutOrg: Session = {
  user: { id: "u1", email: "ada@example.com", display_name: "Ada" },
  mfa_enabled: false,
  recently_authenticated: true,
  memberships: [],
  active: null,
};

const withOrg: Session = {
  ...withoutOrg,
  memberships: [{ id: "m1", organization, role: { key: "owner", name: "Owner" }, status: "active" }],
  active: { membership_id: "m1", organization, role: { key: "owner", name: "Owner" }, permissions: { "deals.view": "all" }, mfa_required: false },
};

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthGate>{(session) => <p>Welcome to {session.active?.organization.name}</p>}</AuthGate>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("AuthGate", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(bootstrapSession).mockReset();
    vi.mocked(logout).mockReset();
    replace.mockReset();
  });

  it("renders the CRM straight away when the session has an active organization", async () => {
    vi.mocked(getSession).mockResolvedValue(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    expect(bootstrapSession).not.toHaveBeenCalled();
  });

  it("bootstraps a session without an organization once, then renders the CRM (no onboarding step)", async () => {
    vi.mocked(getSession).mockResolvedValue(withoutOrg);
    vi.mocked(bootstrapSession).mockResolvedValue(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    expect(bootstrapSession).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("explains when the server finds no usable membership instead of looping", async () => {
    vi.mocked(getSession).mockResolvedValue(withoutOrg);
    vi.mocked(bootstrapSession).mockResolvedValue(withoutOrg);
    renderGate();
    expect(await screen.findByText("No workspace available")).toBeInTheDocument();
    expect(bootstrapSession).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("signs out to the sign-in page from the no-workspace message", async () => {
    vi.mocked(getSession).mockResolvedValue(withoutOrg);
    vi.mocked(bootstrapSession).mockResolvedValue(withoutOrg);
    vi.mocked(logout).mockResolvedValue(undefined);
    renderGate();
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when bootstrapping fails", async () => {
    vi.mocked(getSession).mockResolvedValue(withoutOrg);
    vi.mocked(bootstrapSession).mockRejectedValue(new ApiError(parseProblem(500, { type: "server_error", title: "Server error", status: 500 })));
    renderGate();
    expect(await screen.findByText("We couldn't open your workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("stops rendering the CRM once the session is revoked server-side", async () => {
    // The regression this guards: the gate had a live session cached, so when the re-resolve came
    // back "not authenticated" React Query kept serving the stale session and the CRM shell stayed
    // on screen for a session the server had already thrown away.
    vi.mocked(getSession).mockResolvedValueOnce(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();

    vi.mocked(getSession).mockRejectedValue(notAuthenticated());
    // What an API call discovering the dead session does (see setUnauthenticatedHandler in the gate).
    unauthenticated();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?next=%2Fcontacts%3Fview%3Dall"));
    expect(screen.queryByText("Welcome to Ada's workspace")).not.toBeInTheDocument();
  });

  it("replaces the CRM with one explanation when Workeasy360 says access has ended", async () => {
    vi.mocked(getSession).mockResolvedValue(withOrg);
    vi.mocked(logout).mockResolvedValue(undefined);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();

    accessEnded();

    expect(await screen.findByRole("heading", { level: 1, name: "Easy CRM access has ended" })).toBeInTheDocument();
    expect(screen.getByText(ACCESS_ENDED_DETAIL)).toBeInTheDocument();
    expect(screen.queryByText("Welcome to Ada's workspace")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("shows the person-level message when only this person's access ended (removed member, seat taken away)", async () => {
    const detail = "Your access to Easy CRM in this organization has ended. Ask an administrator in Workeasy360.";
    vi.mocked(getSession).mockResolvedValue(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    act(() =>
      accessEndedRegistered?.(
        new ApiError(parseProblem(403, { type: "workeasy360_access_ended", title: "Forbidden", status: 403, detail })),
      ),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Easy CRM access has ended" })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("says it cannot confirm the access, rather than that it ended, when Workeasy360 refused the check", async () => {
    vi.mocked(getSession).mockResolvedValue(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    act(() =>
      accessEndedRegistered?.(
        new ApiError(
          parseProblem(403, { type: "workeasy360_access_unverified", title: "Forbidden", status: 403, detail: "cannot confirm" }),
        ),
      ),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Easy CRM can't confirm your access" })).toBeInTheDocument();
  });

  it("offers the person's other organizations on the access-ended screen, and only when there are some", async () => {
    const other = { ...organization, id: "o2", name: "Grace's studio" };
    const twoOrgs: Session = {
      ...withOrg,
      memberships: [
        ...withOrg.memberships,
        { id: "m2", organization: other, role: { key: "owner", name: "Owner" }, status: "active" },
        { id: "m3", organization: { ...other, id: "o3", name: "Suspended Co" }, role: { key: "owner", name: "Owner" }, status: "suspended" },
      ],
    };
    vi.mocked(getSession).mockResolvedValue(twoOrgs);
    vi.mocked(switchOrganization).mockResolvedValue({});
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    accessEnded();

    expect(await screen.findByRole("heading", { level: 1, name: "Easy CRM access has ended" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Switch to Ada/ })).not.toBeInTheDocument(); // the one that ended
    expect(screen.queryByRole("button", { name: /Suspended Co/ })).not.toBeInTheDocument(); // not an active membership
    await userEvent.click(screen.getByRole("button", { name: "Switch to Grace's studio" }));

    await waitFor(() => expect(vi.mocked(switchOrganization).mock.calls[0]?.[0]).toBe("m2"));
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument(); // the gate re-resolved the session
  });

  it("sends a session with no Workeasy360 identity to sign in with Workeasy360 (not 'try again')", async () => {
    const detail = "Sign in with Workeasy360 to keep using Easy CRM.";
    vi.mocked(getSession).mockResolvedValue(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    act(() =>
      accessEndedRegistered?.(
        new ApiError(parseProblem(403, { type: "workeasy360_sign_in_required", title: "Forbidden", status: 403, detail })),
      ),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in with Workeasy360" })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with Workeasy360" })).toHaveAttribute(
      "href",
      "/api/auth/workeasy360/start?next=%2Fcontacts%3Fview%3Dall",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("offers no organization switch when the person has only the one", async () => {
    vi.mocked(getSession).mockResolvedValue(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    accessEnded();
    expect(await screen.findByRole("heading", { level: 1, name: "Easy CRM access has ended" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Switch to/ })).not.toBeInTheDocument();
  });

  it("goes back to the CRM when Try again finds the access renewed", async () => {
    vi.mocked(getSession).mockResolvedValue(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    accessEnded();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
  });

  it("sends a visitor without a session to sign in, keeping where they were going", async () => {
    vi.mocked(getSession).mockRejectedValue(notAuthenticated());
    renderGate();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?next=%2Fcontacts%3Fview%3Dall"));
    expect(screen.queryByText("We couldn't load your session")).not.toBeInTheDocument();
    expect(bootstrapSession).not.toHaveBeenCalled();
  });

  it("offers a retry, not a redirect, when the session endpoint itself fails", { timeout: 10000 }, async () => {
    vi.mocked(getSession).mockRejectedValue(new ApiError(parseProblem(502, { type: "bad_gateway", title: "Bad gateway", status: 502 })));
    renderGate();
    // useSession retries non-auth failures twice with backoff before giving up.
    expect(await screen.findByText("We couldn't load your session", undefined, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
