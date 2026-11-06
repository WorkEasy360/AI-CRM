import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserMenu } from "@/components/shell/user-menu";
import { ToastProvider } from "@/components/ui/toast";
import type { Session } from "@/lib/api/types";
import { clearSignedOutMarker, hasSignedOutMarker } from "@/lib/direct-sign-in";

// logout() runs for real: it is what leaves the signed-out marker. Only its HTTP call is answered here.
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/client")>()),
  request: requestMock,
}));
vi.mock("@/lib/api/endpoints", () => ({ switchOrganization: vi.fn() }));
vi.mock("@/lib/auth-methods", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-methods")>()),
  useAuthMethods: () => ({ data: { password: false, workeasy360: true, workeasy360_sign_out: true } }),
}));
vi.mock("@/lib/external-navigation", () => ({ replaceLocation: vi.fn(), navigateExternal: vi.fn() }));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
}));

import { navigateExternal, replaceLocation } from "@/lib/external-navigation";

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

const session: Session = {
  user: { id: "u1", email: "ada@example.com", display_name: "Ada" },
  mfa_enabled: false,
  recently_authenticated: true,
  identity_provider: "workeasy360",
  memberships: [{ id: "m1", organization, role: { key: "owner", name: "Owner" }, status: "active" }],
  active: { membership_id: "m1", organization, role: { key: "owner", name: "Owner" }, permissions: {}, mfa_required: false },
};

function renderMenu() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <UserMenu session={session} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function choose(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Account menu" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

describe("UserMenu sign-outs leave the signed-out marker", () => {
  beforeEach(() => {
    replace.mockReset();
    vi.mocked(navigateExternal).mockReset();
    vi.mocked(replaceLocation).mockReset();
    requestMock.mockReset().mockResolvedValue({ status: 200, ok: true, json: {}, headers: new Headers() });
    clearSignedOutMarker();
  });

  it("'Sign out of WorkEasy CRM' ends WorkEasy CRM's session, leaves the marker and goes to the sign-in page", async () => {
    renderMenu();
    await choose("Sign out of WorkEasy CRM");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(requestMock).toHaveBeenCalledWith("/_allauth/browser/v1/auth/session", { method: "DELETE" });
    expect(hasSignedOutMarker()).toBe(true);
    expect(navigateExternal).not.toHaveBeenCalled();
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it("'Sign out of WorkEasy CRM and Workeasy360' leaves the marker too, then goes on to Workeasy360", async () => {
    renderMenu();
    await choose("Sign out of WorkEasy CRM and Workeasy360");
    await waitFor(() => expect(navigateExternal).toHaveBeenCalledWith("/api/auth/workeasy360/logout"));
    expect(requestMock).toHaveBeenCalledWith("/_allauth/browser/v1/auth/session", { method: "DELETE" });
    expect(hasSignedOutMarker()).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it("a sign-out the server clearly refused leaves no marker (the person is still signed in) and goes nowhere", async () => {
    requestMock.mockResolvedValue({ status: 403, ok: false, json: { status: 403 }, headers: new Headers() });
    renderMenu();
    await choose("Sign out of WorkEasy CRM");
    expect(await screen.findByText("Sign out failed")).toBeInTheDocument();
    expect(hasSignedOutMarker()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(navigateExternal).not.toHaveBeenCalled();
  });

  it("a sign-out whose outcome is unclear keeps the marker (the session may be gone) and goes nowhere", async () => {
    requestMock.mockRejectedValue(new TypeError("network down"));
    renderMenu();
    await choose("Sign out of WorkEasy CRM");
    expect(await screen.findByText("Sign out failed")).toBeInTheDocument();
    expect(hasSignedOutMarker()).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect(navigateExternal).not.toHaveBeenCalled();
  });
});
