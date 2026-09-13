import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "@/components/auth-gate";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError, parseProblem } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/endpoints", () => ({
  getSession: vi.fn(),
  bootstrapSession: vi.fn(),
}));
vi.mock("@/lib/api/allauth", () => ({
  logout: vi.fn(),
}));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
  usePathname: () => "/pipeline",
  useSearchParams: () => new URLSearchParams(""),
}));

import { bootstrapSession, getSession } from "@/lib/api/endpoints";

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
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("offers a retry when bootstrapping fails", async () => {
    vi.mocked(getSession).mockResolvedValue(withoutOrg);
    vi.mocked(bootstrapSession).mockRejectedValue(new ApiError(parseProblem(500, { type: "server_error", title: "Server error", status: 500 })));
    renderGate();
    expect(await screen.findByText("We couldn't open your workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("sends signed-out visitors to the login page with the current path", async () => {
    vi.mocked(getSession).mockRejectedValue(new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 })));
    renderGate();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?next=%2Fpipeline"));
    expect(bootstrapSession).not.toHaveBeenCalled();
  });
});
