import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";
import { ApiError, parseProblem } from "@/lib/api/problem";

vi.mock("@/lib/api/allauth", () => ({ login: vi.fn(), mfaAuthenticate: vi.fn() }));
vi.mock("@/lib/api/endpoints", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/external-navigation", () => ({ replaceLocation: vi.fn(), navigateExternal: vi.fn() }));

let methods: { data?: { password: boolean; workeasy360: boolean }; isError: boolean } = {
  data: { password: true, workeasy360: false },
  isError: false,
};
vi.mock("@/lib/auth-methods", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-methods")>()),
  useAuthMethods: () => methods,
}));

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
  useSearchParams: () => search,
}));

import { login, mfaAuthenticate } from "@/lib/api/allauth";
import { getSession } from "@/lib/api/endpoints";
import { clearSignedOutMarker } from "@/lib/direct-sign-in";
import { navigateExternal, replaceLocation } from "@/lib/external-navigation";

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
    methods = { data: { password: true, workeasy360: false }, isError: false };
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
  it("asks 'Already a Workeasy360 user?' first, keeping the next path, with the password on request", async () => {
    search = new URLSearchParams("next=/contacts");
    methods = { data: { password: true, workeasy360: true }, isError: false };
    renderForm();
    expect(screen.getByRole("heading", { name: "Already a Workeasy360 user?" })).toBeInTheDocument();
    expect(screen.getByText("Access WorkEasy CRM using your Workeasy360 account.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Access WorkEasy CRM" });
    expect(link).toHaveAttribute("href", "/api/auth/workeasy360/start?next=%2Fcontacts");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    const other = screen.getByRole("button", { name: "Use another sign-in method" });
    expect(other).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(other);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Access WorkEasy CRM" })).toBeInTheDocument();
  });

  it("shows only Workeasy360 when password sign-in is off", () => {
    methods = { data: { password: false, workeasy360: true }, isError: false };
    renderForm();
    expect(screen.getByRole("link", { name: "Access WorkEasy CRM" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use another sign-in method" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByText("Forgot password?")).not.toBeInTheDocument();
    expect(screen.queryByText("Create account")).not.toBeInTheDocument();
  });

  it("explains a Workeasy360 sign-in failure from the fixed vocabulary", () => {
    search = new URLSearchParams("sso_error=no_seat");
    methods = { data: { password: false, workeasy360: true }, isError: false };
    renderForm();
    expect(screen.getByRole("alert")).toHaveTextContent("assign you one");
  });

  it("never echoes an unknown sso_error value", () => {
    search = new URLSearchParams("sso_error=<script>alert(1)</script>");
    methods = { data: { password: false, workeasy360: true }, isError: false };
    renderForm();
    expect(screen.getByRole("alert")).toHaveTextContent("could not complete the sign-in");
    expect(screen.queryByText(/script/)).not.toBeInTheDocument();
  });

  it("falls back to the password form when the methods cannot be loaded", () => {
    methods = { data: undefined, isError: true };
    renderForm();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  describe("never starts a Workeasy360 sign-in by itself (Workeasy360 integration guide 6b)", () => {
    // The sign-in page is where a visitor lands after a refusal or a sign-out: it shows "Access WorkEasy CRM"
    // and waits for the click, whatever its query, with no session, no marker and no recent start.
    beforeEach(() => {
      methods = { data: { password: false, workeasy360: true }, isError: false };
      vi.mocked(replaceLocation).mockReset();
      vi.mocked(navigateExternal).mockReset();
      clearSignedOutMarker();
      window.sessionStorage.clear();
    });

    it.each([
      ["no query", ""],
      ["a next path", "next=/contacts"],
      ["a refusal (sso_error)", "sso_error=cancelled"],
      ["a refusal and a next path", "sso_error=not_entitled&next=/deals"],
      ["an unknown sso_error", "sso_error=whatever"],
    ])("waits for the click, with %s", async (_label, query) => {
      search = new URLSearchParams(query);
      renderForm();
      expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Access WorkEasy CRM" })).toHaveAttribute("href", expect.stringContaining("/api/auth/workeasy360/start"));
      // Give any effect the chance to navigate.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(replaceLocation).not.toHaveBeenCalled();
      expect(navigateExternal).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    });
  });
});
