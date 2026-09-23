import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignupForm } from "@/components/auth/signup-form";

vi.mock("@/lib/api/allauth", () => ({
  signup: vi.fn(),
}));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, prefetch: vi.fn() }),
}));

import { signup } from "@/lib/api/allauth";

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SignupForm />
    </QueryClientProvider>,
  );
}

describe("SignupForm", () => {
  beforeEach(() => {
    vi.mocked(signup).mockReset();
    replace.mockReset();
  });

  it("asks only for name, email and password and never for an organization", () => {
    renderForm();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText(/organization/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/organization/i)).not.toBeInTheDocument();
  });

  it("submits the name with the credentials and shows the verification screen", async () => {
    const user = userEvent.setup();
    vi.mocked(signup).mockResolvedValue({ kind: "verify_email" });
    renderForm();

    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signup).toHaveBeenCalledWith({ name: "Ada Lovelace", email: "ada@example.com", password: "correct-horse-battery" }));
    expect(await screen.findByTestId("signup-check-email")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("opens the pipeline directly when the account is authenticated on signup", async () => {
    const user = userEvent.setup();
    vi.mocked(signup).mockResolvedValue({ kind: "authenticated" });
    renderForm();

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/pipeline"));
  });

  it("validates before calling the API", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Enter your name.")).toBeInTheDocument();
    expect(signup).not.toHaveBeenCalled();
  });
});
