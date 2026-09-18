import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptInvitation } from "@/components/auth/accept-invitation";
import { ApiError } from "@/lib/api/problem";
import type { InvitationPreview, Session } from "@/lib/api/types";

const nav = vi.hoisted(() => ({ search: "token=tok_123", replace: vi.fn() }));
const auth = vi.hoisted(() => ({ session: null as Session | null }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/lib/api/endpoints", () => ({
  previewInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  registerWithInvitation: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    useSession: () =>
      auth.session
        ? { data: auth.session, isPending: false, isError: false }
        : { data: undefined, isPending: false, isError: true, error: new ApiError({ type: "not_authenticated", title: "", status: 403 }) },
  };
});

import { acceptInvitation, getSession, previewInvitation, registerWithInvitation } from "@/lib/api/endpoints";

const PREVIEW: InvitationPreview = {
  organization_name: "Acme",
  email: "new.person@example.com",
  name: "New Person",
  role: "sales_rep",
  role_name: "Sales Representative",
  invited_by: "Olivia Owner",
  expires_at: "2026-09-24T00:00:00Z",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AcceptInvitation />
    </QueryClientProvider>,
  );
}

describe("AcceptInvitation", () => {
  beforeEach(() => {
    nav.search = "token=tok_123";
    nav.replace.mockReset();
    auth.session = null;
    vi.mocked(previewInvitation).mockReset().mockResolvedValue(PREVIEW);
    vi.mocked(registerWithInvitation).mockReset();
    vi.mocked(acceptInvitation).mockReset();
    vi.mocked(getSession).mockReset().mockResolvedValue({ active: { mfa_required: false } } as unknown as Session);
  });

  it("lets a new person create their own password and enter the CRM", async () => {
    const user = userEvent.setup();
    vi.mocked(registerWithInvitation).mockResolvedValue({ membership_id: "m1", organization: {} as never });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Join Acme" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("New Person");
    expect(screen.getByText("new.person@example.com", { selector: "p" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create account and join" }));

    await waitFor(() =>
      expect(registerWithInvitation).toHaveBeenCalledWith({ token: "tok_123", name: "New Person", password: "correct-horse-battery" }),
    );
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/pipeline"));
  });

  it("sends people to Security first when the organization requires MFA", async () => {
    const user = userEvent.setup();
    vi.mocked(registerWithInvitation).mockResolvedValue({ membership_id: "m1", organization: {} as never });
    vi.mocked(getSession).mockResolvedValue({ active: { mfa_required: true } } as unknown as Session);
    renderPage();
    await user.type(await screen.findByLabelText("Password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create account and join" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/settings/security"));
  });

  it("validates the password locally before calling the API", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText("Password"), "short");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(screen.getByRole("button", { name: "Create account and join" }));
    expect(await screen.findByText("Use at least 12 characters.")).toBeInTheDocument();
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(registerWithInvitation).not.toHaveBeenCalled();
  });

  it("tells existing account holders the account is already there", async () => {
    const user = userEvent.setup();
    vi.mocked(registerWithInvitation).mockRejectedValue(
      new ApiError({ type: "account_exists", title: "Conflict", status: 409, detail: "An account already exists." }),
    );
    renderPage();
    await user.type(await screen.findByLabelText("Password"), "correct-horse-battery");
    await user.type(screen.getByLabelText("Confirm password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create account and join" }));
    const link = await screen.findByRole("link", { name: "Go to the CRM" });
    expect(link).toHaveAttribute("href", "/pipeline");
  });

  it("shows a generic message for invalid, used or expired links", async () => {
    vi.mocked(previewInvitation).mockRejectedValue(new ApiError({ type: "invitation_invalid", title: "Not found", status: 404 }));
    renderPage();
    expect(await screen.findByRole("heading", { name: "Invitation unavailable" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("signed-in invitees with a different email cannot accept", async () => {
    auth.session = { user: { id: "u1", email: "someone.else@example.com", display_name: "Else" } } as Session;
    renderPage();
    expect(await screen.findByText(/signed in as someone.else@example.com/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeDisabled();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("signed-in invitees accept with one click", async () => {
    const user = userEvent.setup();
    auth.session = { user: { id: "u1", email: "new.person@example.com", display_name: "New" } } as Session;
    vi.mocked(acceptInvitation).mockResolvedValue({ membership_id: "m1", organization: {} as never });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalled());
    expect(vi.mocked(acceptInvitation).mock.calls[0]?.[0]).toBe("tok_123");
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/pipeline"));
  });
});
