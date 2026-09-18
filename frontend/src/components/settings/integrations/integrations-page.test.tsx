import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReauthProvider } from "@/components/reauth-provider";
import { IntegrationsPage } from "@/components/settings/integrations/integrations-page";
import { ToastProvider } from "@/components/ui/toast";
import type { ConnectionSummary, IntegrationCatalog } from "@/lib/api/integrations";
import type { Session } from "@/lib/api/types";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn(), push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, prefetch: vi.fn() }),
  usePathname: () => "/settings/integrations",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/lib/api/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/integrations")>();
  return { ...actual, getIntegrationCatalog: vi.fn(), getIntegrationOptions: vi.fn(), createConnection: vi.fn(), startConnectionOAuth: vi.fn() };
});

const SESSION = { active: { membership_id: "m1", permissions: { "integrations.view": "all", "integrations.manage": "all", "webhooks.manage": "all" } } } as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { getIntegrationCatalog, getIntegrationOptions } from "@/lib/api/integrations";

const CONNECTION: ConnectionSummary = {
  id: "c1",
  provider: "generic_rest",
  provider_name: "Generic REST API",
  name: "Marketing platform",
  status: "action_required",
  status_message: "Your Generic REST API connection has expired. Reconnect your account.",
  auth_type: "oauth2_code",
  config: { base_url: "https://api.example.com/v1" },
  credentials_configured: ["client_secret"],
  conflict_strategy: "manual",
  sync_interval_minutes: 0,
  next_sync_at: null,
  inbound_enabled: false,
  connected_by: { id: "m1", display_name: "Ada" },
  connected_at: "2026-09-01T00:00:00Z",
  disconnected_at: null,
  last_sync_at: null,
  last_success_at: null,
  last_error_code: "auth_expired",
  last_error_message: "Your Generic REST API connection has expired. Reconnect your account.",
  last_error_at: null,
  consecutive_failures: 1,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

function catalog(canManage: boolean, canManageWebhooks = canManage): IntegrationCatalog {
  const base = { auth_types: [], supports_sync: false, supports_inbound_webhooks: false };
  return {
    results: [
      { ...base, key: "google", name: "Google Workspace", description: "Send Gmail from records.", category: "email", manage_url: "/settings/email", status: "connected", connected_count: 2, configured: true, error_count: 0, mine: null, connections: [] },
      { ...base, key: "microsoft", name: "Microsoft 365", description: "Send Outlook email.", category: "email", manage_url: "/settings/email", status: "available", connected_count: 0, configured: true, error_count: 0, mine: null, connections: [] },
      { ...base, key: "whatsapp", name: "WhatsApp Business", description: "Message customers.", category: "messaging", manage_url: "/settings/whatsapp", status: "connected", connected_count: 1, configured: true, error_count: 0, mine: null, connections: [] },
      { ...base, key: "generic_rest", name: "Generic REST API", description: "Connect any JSON REST API.", category: "custom", manage_url: null, status: "connected", connected_count: 1, connections: [CONNECTION] },
    ],
    can_manage: canManage,
    can_manage_webhooks: canManageWebhooks,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReauthProvider>
          <IntegrationsPage />
        </ReauthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("IntegrationsPage", () => {
  beforeEach(() => {
    nav.search = "";
    nav.replace.mockReset();
    nav.push.mockReset();
    vi.mocked(getIntegrationCatalog).mockReset();
    vi.mocked(getIntegrationOptions).mockReset().mockResolvedValue({
      entities: [],
      directions: [],
      conflict_strategies: [],
      sync_intervals: [0],
      webhook_event_types: [],
      api_scopes: [],
      api_key_max_days: 365,
      oauth_redirect_uri: "https://app.example.com/api/v1/integrations/oauth/callback/",
    });
  });

  it("groups connected and available integrations and shows the manage actions", async () => {
    vi.mocked(getIntegrationCatalog).mockResolvedValue(catalog(true));
    renderPage();

    const connected = await screen.findByRole("region", { name: "Connected" });
    expect(within(connected).getByText("Google Workspace")).toBeInTheDocument();
    expect(within(connected).getByText("WhatsApp Business")).toBeInTheDocument();
    expect(within(connected).getByText("Marketing platform")).toBeInTheDocument();
    // A connection that is not connected explains why, in words.
    expect(within(connected).getByText(CONNECTION.status_message)).toBeInTheDocument();
    expect(within(connected).getByText("Action required")).toBeInTheDocument();
    expect(within(connected).getByRole("link", { name: "Manage Marketing platform" })).toHaveAttribute("href", "/settings/integrations/c1");
    expect(within(connected).getByRole("link", { name: "Manage WhatsApp Business" })).toHaveAttribute("href", "/settings/whatsapp");

    const available = screen.getByRole("region", { name: "Available" });
    expect(within(available).getByText("Microsoft 365")).toBeInTheDocument();
    expect(within(available).getByText("Generic REST API")).toBeInTheDocument();
    expect(within(available).getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(within(available).getByRole("link", { name: "Configure" })).toHaveAttribute("href", "/settings/integrations/webhooks");
    expect(within(available).getByRole("link", { name: "Manage keys" })).toHaveAttribute("href", "/settings/integrations/api-keys");
  });

  it("hides manage actions when the member cannot manage integrations or webhooks", async () => {
    vi.mocked(getIntegrationCatalog).mockResolvedValue(catalog(false, false));
    renderPage();

    const connected = await screen.findByRole("region", { name: "Connected" });
    expect(within(connected).getByText("Marketing platform")).toBeInTheDocument();
    expect(within(connected).getByRole("link", { name: "View Marketing platform" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Manage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Configure" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage keys" })).not.toBeInTheDocument();
    // The cards themselves stay visible so the member knows what exists.
    expect(screen.getByText("Webhooks")).toBeInTheDocument();
    expect(screen.getByText("API keys")).toBeInTheDocument();
  });

  it("reports a failed OAuth return from the query string and cleans the URL", async () => {
    nav.search = "oauth=denied";
    vi.mocked(getIntegrationCatalog).mockResolvedValue(catalog(true));
    renderPage();

    expect(await screen.findByText("Connection not authorized")).toBeInTheDocument();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/settings/integrations", { scroll: false }));
  });
});
