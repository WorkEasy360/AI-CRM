import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailSettingsPage, NOT_CONFIGURED_MESSAGE } from "@/components/settings/email-settings-page";
import { ToastProvider } from "@/components/ui/toast";
import type { EmailAccount } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, prefetch: vi.fn() }),
  usePathname: () => "/settings/email",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/lib/external-navigation", () => ({
  navigateExternal: vi.fn(),
  isSafeExternalUrl: (url: string) => url.startsWith("https://"),
}));

vi.mock("@/lib/api/crm", () => ({
  listEmailProviders: vi.fn(),
  listEmailAccounts: vi.fn(),
  connectEmailAccount: vi.fn(),
  disconnectEmailAccount: vi.fn(),
  listEmailTemplates: vi.fn(),
  createEmailTemplate: vi.fn(),
  updateEmailTemplate: vi.fn(),
  deleteEmailTemplate: vi.fn(),
}));

const SESSION = {
  active: { membership_id: "m1", permissions: { "email.view": "all", "email.connect": "all", "email.templates_manage": "all" } },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { connectEmailAccount, listEmailAccounts, listEmailProviders, listEmailTemplates } from "@/lib/api/crm";
import { navigateExternal } from "@/lib/external-navigation";

const EMPTY_PAGE = { next: null, previous: null, results: [] };
const PROVIDERS = {
  results: [
    { key: "gmail" as const, label: "Gmail", configured: true },
    { key: "microsoft" as const, label: "Microsoft 365", configured: false },
  ],
};
const ACCOUNT: EmailAccount = {
  id: "a1",
  provider: "gmail",
  email_address: "me@example.com",
  display_name: "Me",
  status: "error",
  error_message: "Token expired",
  last_sync_at: null,
  connected_at: "2026-09-01T00:00:00Z",
  membership: { id: "m1", display_name: "Me" },
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <EmailSettingsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("EmailSettingsPage", () => {
  beforeEach(() => {
    nav.search = "";
    nav.replace.mockReset();
    vi.mocked(navigateExternal).mockReset();
    vi.mocked(connectEmailAccount).mockReset();
    vi.mocked(listEmailProviders).mockReset().mockResolvedValue(PROVIDERS);
    vi.mocked(listEmailAccounts).mockReset().mockResolvedValue(EMPTY_PAGE);
    vi.mocked(listEmailTemplates).mockReset().mockResolvedValue(EMPTY_PAGE);
  });

  it("starts the OAuth flow for a configured provider and navigates to the authorization URL", async () => {
    vi.mocked(connectEmailAccount).mockResolvedValue({ authorization_url: "https://accounts.google.com/o/oauth2/auth?state=abc" });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Connect Gmail" }));

    await waitFor(() => expect(connectEmailAccount).toHaveBeenCalledWith("gmail"));
    await waitFor(() => expect(navigateExternal).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?state=abc"));
  });

  it("disables providers that are not configured and explains why", async () => {
    renderPage();

    const button = await screen.findByRole("button", { name: "Connect Microsoft 365" });
    expect(button).toBeDisabled();
    expect(screen.getByText(NOT_CONFIGURED_MESSAGE)).toBeInTheDocument();
  });

  it("shows a mailbox in error with its message and a reconnect action", async () => {
    vi.mocked(listEmailAccounts).mockResolvedValue({ next: null, previous: null, results: [ACCOUNT] });
    vi.mocked(connectEmailAccount).mockResolvedValue({ authorization_url: "https://accounts.google.com/o/oauth2/auth" });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Token expired")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(connectEmailAccount).toHaveBeenCalledWith("gmail"));
  });

  it("reports the OAuth result from the query string and cleans the URL", async () => {
    nav.search = "connected=1";
    renderPage();

    expect(await screen.findByText("Mailbox connected")).toBeInTheDocument();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/settings/email", { scroll: false }));
  });
});
