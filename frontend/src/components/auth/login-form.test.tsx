import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";
import { ApiError, parseProblem } from "@/lib/api/problem";

vi.mock("@/lib/api/allauth", () => ({ login: vi.fn(), mfaAuthenticate: vi.fn() }));
vi.mock("@/lib/api/endpoints", () => ({ getSession: vi.fn() }));

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
  useSearchParams: () => search,
}));

import { login, mfaAuthenticate } from "@/lib/api/allauth";
import { getSession } from "@/lib/api/endpoints";

const notAuthenticated = () => new ApiError(parseProblem(401, { type: "not_authenticated", title: "Not authenticated", status: 401 }));

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LoginForm />
    </QueryClientProvider>,
  );
}

async function submitCredentials() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "ada@example.com");
  await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("LoginForm", () => {
  beforeEach(() => {
    vi.mocked(login).mockReset();
    vi.mocked(mfaAuthenticate).mockReset();
    vi.mocked(getSession).mockReset().mockRejectedValue(notAuthenticated());
    replace.mockReset();
    search = new URLSearchParams();
  });

  it("signs in and returns to the validated next path", async () => {
    search = new URLSearchParams("next=/contacts?view=all");
    vi.mocked(login).mockResolvedValue({ kind: "authenticated" });
    renderForm();
    await submitCredentials();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/contacts?view=all"));
    expect(login).toHaveBeenCalledWith({ email: "ada@example.com", password: "correct-horse-battery" });
  });

  it("never follows an off-site next parameter", async () => {
    search = new URLSearchParams("next=//evil.example/steal");
    vi.mocked(login).mockResolvedValue({ kind: "authenticated" });
    renderForm();
    await submitCredentials();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/pipeline"));
  });

  it("asks for the authenticator code when MFA is required", async () => {
    vi.mocked(login).mockResolvedValue({ kind: "mfa_required" });
    vi.mocked(mfaAuthenticate).mockResolvedValue({ kind: "authenticated" });
    renderForm();
    const user = await submitCredentials();
    await user.type(await screen.findByLabelText("Authentication code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/pipeline"));
    expect(mfaAuthenticate).toHaveBeenCalledWith("123456");
  });

  it("tells an unverified user to open the verification email", async () => {
    vi.mocked(login).mockResolvedValue({ kind: "verify_email" });
    renderForm();
    await submitCredentials();
    expect(await screen.findByText("Verify your email")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows the server's error for wrong credentials and stays on the form", async () => {
    vi.mocked(login).mockRejectedValue(
      new ApiError(parseProblem(400, { status: 400, errors: [{ message: "The email address and/or password you specified are not correct.", code: "email_password_mismatch" }] })),
    );
    renderForm();
    await submitCredentials();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("skips the form when already signed in", async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "u1", email: "ada@example.com", display_name: "Ada" },
      mfa_enabled: false,
      recently_authenticated: true,
      memberships: [],
      active: null,
    });
    renderForm();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/pipeline"));
    expect(login).not.toHaveBeenCalled();
  });
});
