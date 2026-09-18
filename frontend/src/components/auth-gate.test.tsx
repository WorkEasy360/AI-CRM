import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "@/components/auth-gate";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError, parseProblem } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/endpoints", () => ({
  getSession: vi.fn(),
  bootstrapSession: vi.fn(),
}));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
}));

import { bootstrapSession, getSession } from "@/lib/api/endpoints";

/** Fire whatever handler the gate registered, as a real 401 from any API call would. */
function unauthenticated(): void {
  registered?.(new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 })));
}

let registered: ((error: ApiError) => void) | null = null;
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    setUnauthenticatedHandler: (handler: ((error: ApiError) => void) | null) => {
      registered = handler;
    },
  };
});

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
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("offers a retry when bootstrapping fails", async () => {
    vi.mocked(getSession).mockResolvedValue(withoutOrg);
    vi.mocked(bootstrapSession).mockRejectedValue(new ApiError(parseProblem(500, { type: "server_error", title: "Server error", status: 500 })));
    renderGate();
    expect(await screen.findByText("We couldn't open your workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("stops rendering the CRM once the session is revoked server-side", async () => {
    // The regression this guards: the gate had a live session cached, so when the re-resolve came
    // back "not authenticated" React Query kept serving the stale session and the CRM shell stayed
    // on screen for a session the server had already thrown away.
    vi.mocked(getSession).mockResolvedValueOnce(withOrg);
    renderGate();
    expect(await screen.findByText("Welcome to Ada's workspace")).toBeInTheDocument();

    vi.mocked(getSession).mockRejectedValue(
      new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 })),
    );
    // What an API call discovering the dead session does (see setUnauthenticatedHandler in the gate).
    unauthenticated();

    expect(await screen.findByText("We couldn't load your session")).toBeInTheDocument();
    expect(screen.queryByText("Welcome to Ada's workspace")).not.toBeInTheDocument();
  });

  it("offers a retry instead of redirecting when there is no session (no sign-in page to go to)", async () => {
    vi.mocked(getSession).mockRejectedValue(new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 })));
    renderGate();
    expect(await screen.findByText("We couldn't load your session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(bootstrapSession).not.toHaveBeenCalled();
  });
});
