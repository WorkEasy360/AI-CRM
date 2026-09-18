import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { FALLBACK_ROLES } from "@/lib/roles";

vi.mock("@/lib/api/endpoints", () => ({
  createInvitation: vi.fn(),
}));

vi.mock("@/components/reauth-provider", () => ({
  useReauth: () => ({ runSensitive: <T,>(fn: () => Promise<T>) => fn() }),
  isReauthCancelled: () => false,
}));

import { createInvitation } from "@/lib/api/endpoints";

const TEAMS = [{ id: "t1", name: "Inside Sales", manager_id: null, member_count: 0, created_at: "", updated_at: "" }];

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <InviteMemberDialog open onOpenChange={() => {}} roles={FALLBACK_ROLES} teams={TEAMS} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("InviteMemberDialog", () => {
  beforeEach(() => {
    vi.mocked(createInvitation).mockReset();
  });

  it("shows zod validation errors and does not call the API when the form is empty", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Choose a role.")).toBeInTheDocument();
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("rejects a malformed email address", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("marks the email input invalid for assistive tech", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true"));
  });

  it("does not offer the owner role", () => {
    renderDialog();
    expect(screen.queryByRole("option", { name: "Owner" })).not.toBeInTheDocument();
  });

  it("asks for name, email, role and an optional team, never a password", () => {
    renderDialog();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toBeInTheDocument();
    expect(screen.getByLabelText("Team")).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});
