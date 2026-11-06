import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "@/components/auth-gate";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError, parseProblem } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";
import {
  AUTO_START_STORAGE_KEY,
  clearSignedOutMarker,
  hasSignedOutMarker,
  markSignedOut,
} from "@/lib/direct-sign-in";

vi.mock("@/lib/api/endpoints", () => ({
  getSession: vi.fn(),
  bootstrapSession: vi.fn(),
  switchOrganization: vi.fn(),
}));

vi.mock("@/lib/api/allauth", () => ({ logout: vi.fn() }));

// Which sign-ins the server offers (GET /api/v1/auth/methods/), and the navigations the gate may make.
let methods: { data?: { password: boolean; workeasy360: boolean }; isPending: boolean; isError: boolean } = {
  data: { password: true, workeasy360: false },
  isPending: false,
  isError: false,
};
vi.mock("@/lib/auth-methods", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-methods")>()),
  useAuthMethods: () => methods,
}));
vi.mock("@/lib/external-navigation", () => ({ replaceLocation: vi.fn(), navigateExternal: vi.fn() }));

const replace = vi.fn();
let pathname = "/contacts";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams("view=all"),
}));

import { logout } from "@/lib/api/allauth";
import { replaceLocation } from "@/lib/external-navigation";
import { bootstrapSession, getSession, switchOrganization } from "@/lib/api/endpoints";

const notAuthenticated = () => new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 }));

/** Fire whatever handler the gate registered, as a real 401 from any API call would. */
function unauthenticated(): void {
  registered?.(new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 })));
}

let registered: ((error: ApiError) => void) | null = null;
let accessEndedRegistered: ((error: ApiError) => void) | null = null;
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    // Only the real logout() reaches this (the sign-out tests that run it instead of the mock).
    request: requestMock,
    setUnauthenticatedHandler: (handler: ((error: ApiError) => void) | null) => {
      registered = handler;
    },
    setAccessEndedHandler: (handler: ((error: ApiError) => void) | null) => {
      accessEndedRegistered = handler;
    },
  };
});

const ACCESS_ENDED_DETAIL = "Your organization's access to WorkEasy CRM has ended. An owner can renew it in Workeasy360.";

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

function renderGate({ strict = false }: { strict?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthGate>{(session) => <p>Welcome to {session.active?.organization.name}</p>}</AuthGate>
      </ToastProvider>
    </QueryClientProvider>
  );
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
}

/** logout() as it really is (it leaves the signed-out marker), with its HTTP call answered. */
async function useRealLogout(): Promise<void> {
  const actual = await vi.importActual<typeof import("@/lib/api/allauth")>("@/lib/api/allauth");
  requestMock.mockReset().mockResolvedValue({ status: 200, ok: true, json: {}, headers: new Headers() });
  vi.mocked(logout).mockImplementation(actual.logout);
}

/** Let anything the gate might still do after a render (a late effect, a navigation) happen. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const SSO_ONLY = { data: { password: false, workeasy360: true }, isPending: false, isError: false };
const BOTH_WAYS = { data: { password: true, workeasy360: true }, isPending: false, isError: false };
const CONTACTS_START = "/api/auth/workeasy360/start?next=%2Fcontacts%3Fview%3Dall";
const CONTACTS_LOGIN = "/login?next=%2Fcontacts%3Fview%3Dall";

describe("AuthGate", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(bootstrapSession).mockReset();
    vi.mocked(logout).mockReset();
    replace.mockReset();
    vi.mocked(replaceLocation).mockReset();
    methods = { data: { password: true, workeasy360: false }, isPending: false, isError: false };
    pathname = "/contacts";
    clearSignedOutMarker();
    window.sessionStorage.clear();
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

    expect(await screen.findByRole("heading", { level: 1, name: "WorkEasy CRM access has ended" })).toBeInTheDocument();
    expect(screen.getByText(ACCESS_ENDED_DETAIL)).toBeInTheDocument();
    expect(screen.queryByText("Welcome to Ada's workspace")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("shows the person-level message when only this person's access ended (removed member, seat taken away)", async () => {
    const detail = "Your access to WorkEasy CRM in this organization has ended. Ask an administrator in Workeasy360.";
    vi.mocked(getSession).mockResolvedValue(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
    act(() =>
      accessEndedRegistered?.(
        new ApiError(parseProblem(403, { type: "workeasy360_access_ended", title: "Forbidden", status: 403, detail })),
      ),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "WorkEasy CRM access has ended" })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { level: 1, name: "WorkEasy CRM can't confirm your access" })).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { level: 1, name: "WorkEasy CRM access has ended" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Switch to Ada/ })).not.toBeInTheDocument(); // the one that ended
    expect(screen.queryByRole("button", { name: /Suspended Co/ })).not.toBeInTheDocument(); // not an active membership
    await userEvent.click(screen.getByRole("button", { name: "Switch to Grace's studio" }));

    await waitFor(() => expect(vi.mocked(switchOrganization).mock.calls[0]?.[0]).toBe("m2"));
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument(); // the gate re-resolved the session
  });

  it("sends a session with no Workeasy360 identity to sign in with Workeasy360 (not 'try again')", async () => {
    const detail = "Sign in with Workeasy360 to keep using WorkEasy CRM.";
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
    expect(await screen.findByRole("heading", { level: 1, name: "WorkEasy CRM access has ended" })).toBeInTheDocument();
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

  describe("opening WorkEasy CRM directly, when Workeasy360 is the only sign-in", () => {
    beforeEach(() => {
      methods = SSO_ONLY;
      vi.mocked(getSession).mockRejectedValue(notAuthenticated());
    });

    it("goes straight to the start URL for the page asked for, with no sign-in page in between", async () => {
      renderGate();
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(CONTACTS_START));
      expect(replaceLocation).toHaveBeenCalledTimes(1);
      expect(vi.mocked(replaceLocation).mock.calls[0]?.[0]).not.toContain("organization");
      expect(replace).not.toHaveBeenCalled(); // not /login
      expect(bootstrapSession).not.toHaveBeenCalled();
      // The neutral state: exactly one h1, and nothing of the sign-in form.
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getByRole("heading", { level: 1, name: "Signing you in with Workeasy360…" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    });

    it("starts exactly once even when effects run twice (React strict mode)", async () => {
      renderGate({ strict: true });
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(CONTACTS_START));
      await settle();
      expect(replaceLocation).toHaveBeenCalledTimes(1);
      expect(replace).not.toHaveBeenCalled();
    });

    it("keeps one status region for the whole wait and only changes its text, so screen readers announce it", async () => {
      let rejectSession: (error: unknown) => void = () => {};
      vi.mocked(getSession).mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectSession = reject;
        }),
      );
      renderGate();
      const region = screen.getByRole("status");
      expect(region).toHaveTextContent("Loading");

      await act(async () => rejectSession(notAuthenticated()));
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(CONTACTS_START));
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toBe(region); // the same element, not a new one inserted
      expect(region).toBeInTheDocument();
      expect(region).toHaveTextContent("Signing you in with Workeasy360…");
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    });

    it("offers two ways on when the start is still under way after about five seconds", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderGate();
        await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(CONTACTS_START));
        const region = screen.getByRole("status");
        expect(screen.queryByRole("link", { name: "Continue with Workeasy360" })).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Go to the sign-in page" })).not.toBeInTheDocument();

        await act(async () => {
          vi.advanceTimersByTime(4000);
        });
        expect(screen.queryByRole("link", { name: "Continue with Workeasy360" })).not.toBeInTheDocument();

        await act(async () => {
          vi.advanceTimersByTime(1500);
        });
        expect(screen.getByRole("link", { name: "Continue with Workeasy360" })).toHaveAttribute("href", CONTACTS_START);
        expect(screen.getByRole("link", { name: "Go to the sign-in page" })).toHaveAttribute("href", CONTACTS_LOGIN);
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
        expect(screen.getAllByRole("status")).toHaveLength(1);
        expect(screen.getByRole("status")).toBe(region);
        expect(region).toHaveTextContent("taking longer than expected");
        expect(replaceLocation).toHaveBeenCalledTimes(1); // offering a way on starts nothing by itself
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts over when the browser restores the page from its back/forward cache (and a plain pageshow does nothing)", async () => {
      renderGate();
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledTimes(1));
      act(() => {
        window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
      });
      expect(screen.getByRole("heading", { level: 1, name: "Signing you in with Workeasy360…" })).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
      });
      // Deciding again goes through the loop guard the start just recorded: the sign-in page, not a second start.
      await waitFor(() => expect(replace).toHaveBeenCalledWith(CONTACTS_LOGIN));
      expect(replaceLocation).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("heading", { name: "Signing you in with Workeasy360…" })).not.toBeInTheDocument();
    });

    it("also starts when a session that was open is found gone (revoked or expired) while a page is showing", async () => {
      vi.mocked(getSession).mockResolvedValueOnce(withOrg);
      renderGate();
      expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
      vi.mocked(getSession).mockRejectedValue(notAuthenticated());
      unauthenticated();
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(CONTACTS_START));
      expect(replace).not.toHaveBeenCalled();
    });

    it("waits for the session to resolve: nothing starts while it is still loading", async () => {
      vi.mocked(getSession).mockReturnValue(new Promise(() => {}));
      renderGate();
      await settle();
      expect(replaceLocation).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent("Loading");
    });

    it.each([
      ["a protocol-relative address", "//evil.example/steal"],
      ["a backslash trick", "/\\evil.example"],
      ["an encoded slash", "/%2Fevil.example"],
      ["an absolute URL", "https://evil.example/"],
      ["whitespace", "/a b"],
    ])("never forwards a hostile next (%s)", async (_label, hostile) => {
      pathname = hostile;
      renderGate();
      await waitFor(() => expect(replaceLocation).toHaveBeenCalled());
      expect(replaceLocation).toHaveBeenCalledWith("/api/auth/workeasy360/start");
      expect(vi.mocked(replaceLocation).mock.calls[0]?.[0]).not.toContain("evil");
    });

    it("never starts while the signed-out marker is set: the sign-in page is shown instead", async () => {
      markSignedOut();
      renderGate();
      await waitFor(() => expect(replace).toHaveBeenCalledWith(CONTACTS_LOGIN));
      expect(replaceLocation).not.toHaveBeenCalled();
    });

    it("starts again once a sign-in has cleared the marker", async () => {
      markSignedOut();
      clearSignedOutMarker();
      renderGate();
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(CONTACTS_START));
      expect(replace).not.toHaveBeenCalled();
    });

    it("signing out leaves the marker, so a gate that then finds the session gone shows the sign-in page, not a silent sign-in", async () => {
      vi.mocked(getSession).mockResolvedValueOnce(withOrg);
      await useRealLogout();
      renderGate();
      expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
      accessEnded(); // the one screen with a Sign out button that needs no menu
      await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));

      expect(hasSignedOutMarker()).toBe(true);
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
      vi.mocked(getSession).mockRejectedValue(notAuthenticated());
      unauthenticated(); // any other call finds the session gone
      await waitFor(() => expect(replace).toHaveBeenCalledWith(CONTACTS_LOGIN));
      expect(replaceLocation).not.toHaveBeenCalled();
    });

    it("starts by itself at most once a minute: a second visit right after, still with no session, gets the sign-in page", async () => {
      const first = renderGate();
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledTimes(1));
      expect(window.sessionStorage.getItem(AUTO_START_STORAGE_KEY)).not.toBeNull();
      first.unmount();

      renderGate(); // the callback came back without a session (a dropped cookie, say)
      await waitFor(() => expect(replace).toHaveBeenCalledWith(CONTACTS_LOGIN));
      expect(replaceLocation).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("heading", { level: 1, name: "Signing you in with Workeasy360…" })).not.toBeInTheDocument();
    });

    it("the loop guard is a minute long", async () => {
      window.sessionStorage.setItem(AUTO_START_STORAGE_KEY, String(Date.now() - 10_000));
      const recent = renderGate();
      await waitFor(() => expect(replace).toHaveBeenCalledWith(CONTACTS_LOGIN));
      expect(replaceLocation).not.toHaveBeenCalled();
      recent.unmount();

      replace.mockReset();
      window.sessionStorage.setItem(AUTO_START_STORAGE_KEY, String(Date.now() - 61_000));
      renderGate();
      await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(CONTACTS_START));
      expect(replace).not.toHaveBeenCalled();
    });

    it("a session spends the loop guard (a sign-in that worked is not a loop)", async () => {
      window.sessionStorage.setItem(AUTO_START_STORAGE_KEY, String(Date.now() - 1_000));
      vi.mocked(getSession).mockResolvedValue(withOrg);
      renderGate();
      expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
      await waitFor(() => expect(window.sessionStorage.getItem(AUTO_START_STORAGE_KEY)).toBeNull());
      expect(replaceLocation).not.toHaveBeenCalled();
    });

    it("keeps the explanation of a session whose access ended: no automatic start", async () => {
      vi.mocked(getSession).mockResolvedValue(withOrg);
      renderGate();
      expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
      accessEnded();
      expect(await screen.findByRole("heading", { level: 1, name: "WorkEasy CRM access has ended" })).toBeInTheDocument();
      await settle();
      expect(replaceLocation).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    });

    it("keeps 'Sign in with Workeasy360' for a session that never came from it: a button, not an automatic start", async () => {
      vi.mocked(getSession).mockResolvedValue(withOrg);
      renderGate();
      expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();
      act(() =>
        accessEndedRegistered?.(
          new ApiError(parseProblem(403, { type: "workeasy360_sign_in_required", title: "Forbidden", status: 403, detail: "Sign in." })),
        ),
      );
      expect(await screen.findByRole("heading", { level: 1, name: "Sign in with Workeasy360" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Sign in with Workeasy360" })).toHaveAttribute("href", CONTACTS_START);
      await settle();
      expect(replaceLocation).not.toHaveBeenCalled();
    });

    it("leaves a failed session lookup to its retry button (that is not a missing session)", { timeout: 10000 }, async () => {
      vi.mocked(getSession).mockRejectedValue(new ApiError(parseProblem(502, { type: "bad_gateway", title: "Bad gateway", status: 502 })));
      renderGate();
      expect(await screen.findByText("We couldn't load your session", undefined, { timeout: 6000 })).toBeInTheDocument();
      expect(replaceLocation).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    });
  });

  describe("opening WorkEasy CRM directly, when it is not the only sign-in", () => {
    beforeEach(() => {
      vi.mocked(getSession).mockRejectedValue(notAuthenticated());
    });

    it("sends the visitor to the sign-in page with the page they asked for, as before, when password sign-in is on too", async () => {
      methods = BOTH_WAYS;
      renderGate();
      await waitFor(() => expect(replace).toHaveBeenCalledWith(CONTACTS_LOGIN));
      expect(replaceLocation).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { level: 1, name: "Signing you in with Workeasy360…" })).not.toBeInTheDocument();
    });

    it("sends a hostile next to the bare sign-in page", async () => {
      methods = BOTH_WAYS;
      pathname = "//evil.example/steal";
      renderGate();
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
      expect(replaceLocation).not.toHaveBeenCalled();
    });

    it("starts nothing when Workeasy360 sign-in is not configured here", async () => {
      methods = { data: { password: false, workeasy360: false }, isPending: false, isError: false };
      renderGate();
      await waitFor(() => expect(replace).toHaveBeenCalledWith(CONTACTS_LOGIN));
      expect(replaceLocation).not.toHaveBeenCalled();
    });

    it("shows the sign-in page (which falls back to the password form) when the server cannot say what it offers", async () => {
      methods = { data: undefined, isPending: false, isError: true };
      renderGate();
      await waitFor(() => expect(replace).toHaveBeenCalledWith(CONTACTS_LOGIN));
      expect(replaceLocation).not.toHaveBeenCalled();
    });

    it("decides nothing until the server has said what it offers", async () => {
      methods = { data: undefined, isPending: true, isError: false };
      renderGate();
      await settle();
      expect(replaceLocation).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent("Loading");
    });
  });
});
