import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VerifyEmail } from "@/components/auth/verify-email";

// The real allauth.ts interprets the response; only the HTTP layer is faked.
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, request: vi.fn() };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ key: "MQ%3A1abc%3Asig" }),
}));

import { request } from "@/lib/api/client";

function respond(status: number, json: unknown) {
  vi.mocked(request).mockResolvedValue({ status, ok: status >= 200 && status < 300, json, headers: new Headers() });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VerifyEmail />
    </QueryClientProvider>,
  );
}

describe("VerifyEmail", () => {
  beforeEach(() => vi.mocked(request).mockReset());

  it("treats allauth's signed-out 401 as a successful verification and points to sign in", async () => {
    // What production answers with ACCOUNT_LOGIN_ON_EMAIL_CONFIRMATION = False.
    respond(401, { status: 401, data: { flows: [{ id: "login" }, { id: "signup" }, { id: "mfa_login_webauthn" }] }, meta: { is_authenticated: false } });
    renderPage();
    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(request).mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: { key: "MQ:1abc:sig" } });
  });

  it("opens the CRM directly when verification also signed the user in", async () => {
    respond(200, { status: 200, data: { user: { id: 1 } }, meta: { is_authenticated: true } });
    renderPage();
    expect(await screen.findByText("Email verified")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open your CRM" })).toHaveAttribute("href", "/pipeline");
  });

  it("explains a used or expired link instead of the raw error, with a way to sign in", async () => {
    respond(400, { status: 400, errors: [{ message: "Invalid or expired key.", code: "invalid_or_expired_key", param: "key" }] });
    renderPage();
    expect(await screen.findByText("Verification failed")).toBeInTheDocument();
    expect(screen.getByText(/invalid, has expired or was already used/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  });

  it("still fails when verification leaves a flow pending", async () => {
    respond(401, { status: 401, data: { flows: [{ id: "provider_signup", is_pending: true }] }, meta: { is_authenticated: false } });
    renderPage();
    expect(await screen.findByText("Verification failed")).toBeInTheDocument();
  });
});
