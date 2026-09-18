import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReauthProvider } from "@/components/reauth-provider";
import { buildConnectionPayload, CreateConnectionDialog, type ConnectionFormValues } from "@/components/settings/integrations/create-connection-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { ConnectionDetail } from "@/lib/api/integrations";
import { ApiError } from "@/lib/api/problem";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, prefetch: vi.fn() }),
  usePathname: () => "/settings/integrations",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/external-navigation", () => ({
  navigateExternal: vi.fn(),
  isSafeExternalUrl: (url: string) => url.startsWith("https://"),
}));

vi.mock("@/lib/api/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/integrations")>();
  return { ...actual, getIntegrationOptions: vi.fn(), createConnection: vi.fn(), startConnectionOAuth: vi.fn() };
});

import { createConnection, getIntegrationOptions, startConnectionOAuth } from "@/lib/api/integrations";
import { navigateExternal } from "@/lib/external-navigation";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function detail(overrides: Partial<ConnectionDetail>): ConnectionDetail {
  return {
    id: "c1",
    provider: "generic_rest",
    provider_name: "Generic REST API",
    name: "CRM sync",
    status: "connected",
    status_message: "Connected",
    auth_type: "api_key",
    config: {},
    credentials_configured: [],
    conflict_strategy: "manual",
    sync_interval_minutes: 0,
    next_sync_at: null,
    inbound_enabled: false,
    connected_by: null,
    connected_at: null,
    disconnected_at: null,
    last_sync_at: null,
    last_success_at: null,
    last_error_code: "",
    last_error_message: "",
    last_error_at: null,
    consecutive_failures: 0,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    sharing: [],
    latest_job: null,
    open_conflicts: 0,
    failed_deliveries: 0,
    ...overrides,
  };
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReauthProvider>
          <CreateConnectionDialog open onOpenChange={onOpenChange} />
        </ReauthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

async function chooseAuth(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", { name: "Authentication" }));
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("CreateConnectionDialog", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    // Radix Select relies on pointer-capture and scrollIntoView, which jsdom does not implement.
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    nav.push.mockReset();
    vi.mocked(navigateExternal).mockReset();
    vi.mocked(createConnection).mockReset();
    vi.mocked(startConnectionOAuth).mockReset();
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

  it("creates an API key connection with only its own credential and non-empty conventions, then opens it", async () => {
    vi.mocked(createConnection).mockResolvedValue(detail({ id: "c9", auth_type: "api_key" }));
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "CRM sync");
    await user.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    const secret = screen.getByLabelText("API key");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveAttribute("autocomplete", "off");
    await user.type(secret, "sk_live_123");
    await user.click(screen.getByText("Advanced"));
    await user.type(screen.getByLabelText("Health check path"), "/me");
    await user.type(screen.getByLabelText("API key header"), "X-Api-Key");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    await waitFor(() => expect(createConnection).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createConnection).mock.calls[0]?.[0]).toEqual({
      provider: "generic_rest",
      name: "CRM sync",
      auth_type: "api_key",
      config: { base_url: "https://api.example.com/v1", conventions: { health_path: "/me", api_key_header: "X-Api-Key" } },
      credentials: { api_key: "sk_live_123" },
    });
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/settings/integrations/c9"));
  });

  it("sends OAuth settings for the authorization-code flow and offers Connect with OAuth right away", async () => {
    vi.mocked(createConnection).mockResolvedValue(detail({ id: "c2", name: "Billing", auth_type: "oauth2_code", status: "action_required" }));
    vi.mocked(startConnectionOAuth).mockResolvedValue({ authorization_url: "https://auth.example.com/authorize?state=x" });
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "Billing");
    await chooseAuth(user, "OAuth 2.0 authorization code");
    expect(await screen.findByText("https://app.example.com/api/v1/integrations/oauth/callback/")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Base URL"), "https://api.billing.example");
    await user.type(screen.getByLabelText("Client ID"), "client-1");
    await user.type(screen.getByLabelText("Client secret"), "shh");
    await user.type(screen.getByLabelText("Authorization URL"), "https://auth.example.com/authorize");
    await user.type(screen.getByLabelText("Token URL"), "https://auth.example.com/token");
    await user.type(screen.getByLabelText("Scopes"), "contacts.read  contacts.write");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    await waitFor(() => expect(createConnection).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createConnection).mock.calls[0]?.[0]).toEqual({
      provider: "generic_rest",
      name: "Billing",
      auth_type: "oauth2_code",
      config: {
        base_url: "https://api.billing.example",
        oauth: {
          client_id: "client-1",
          token_url: "https://auth.example.com/token",
          authorize_url: "https://auth.example.com/authorize",
          scopes: ["contacts.read", "contacts.write"],
        },
      },
      credentials: { client_secret: "shh" },
    });

    await user.click(await screen.findByRole("button", { name: "Connect with OAuth" }));
    await waitFor(() => expect(startConnectionOAuth).toHaveBeenCalledWith("c2"));
    await waitFor(() => expect(navigateExternal).toHaveBeenCalledWith("https://auth.example.com/authorize?state=x"));
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("creates a signed-webhook connection without a base URL or credentials", async () => {
    vi.mocked(createConnection).mockResolvedValue(detail({ id: "c3", auth_type: "signed_webhook" }));
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "Form tool");
    await chooseAuth(user, "Signed webhook only");
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    await waitFor(() => expect(createConnection).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createConnection).mock.calls[0]?.[0]).toEqual({ provider: "generic_rest", name: "Form tool", auth_type: "signed_webhook", config: {}, credentials: {} });
  });

  it("shows server field errors next to the matching inputs", async () => {
    vi.mocked(createConnection).mockRejectedValue(
      new ApiError({
        type: "validation_error",
        title: "Invalid request",
        status: 400,
        errors: [
          { field: "base_url", code: "invalid", message: "This address points to a private network and is not allowed." },
          { field: "credentials.api_key", code: "invalid", message: "Invalid value." },
          { field: "conventions.id_field", code: "invalid", message: "Use letters, digits and underscores." },
        ],
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Name"), "Internal");
    await user.type(screen.getByLabelText("Base URL"), "https://10.0.0.5/api");
    await user.type(screen.getByLabelText("API key"), "abc");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    expect(await screen.findByText("This address points to a private network and is not allowed.")).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Invalid value.")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveAttribute("aria-invalid", "true");
    // Errors inside the collapsed Advanced section open it.
    expect(screen.getByText("Use letters, digits and underscores.")).toBeVisible();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("validates required fields before calling the API", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Create connection" }));
    expect(await screen.findByText("Enter a name for this connection.")).toBeInTheDocument();
    expect(screen.getByText("Enter the base URL of the API.")).toBeInTheDocument();
    expect(screen.getByText("Enter the API key.")).toBeInTheDocument();
    expect(createConnection).not.toHaveBeenCalled();
  });
});

describe("buildConnectionPayload", () => {
  const base: ConnectionFormValues = {
    name: " Support desk ",
    auth_type: "bearer_token",
    base_url: "https://desk.example.com/api ",
    api_key: "stale-key",
    token: "tok_1",
    client_secret: "stale-secret",
    client_id: "",
    authorize_url: "",
    token_url: "",
    revoke_url: "",
    scopes: "",
    health_path: "",
    api_key_header: "X-Ignored",
    id_field: "uuid",
    list_key: "",
  };

  it("keeps only the bearer token and drops settings of other authentication types", () => {
    expect(buildConnectionPayload(base)).toEqual({
      provider: "generic_rest",
      name: "Support desk",
      auth_type: "bearer_token",
      config: { base_url: "https://desk.example.com/api", conventions: { id_field: "uuid" } },
      credentials: { token: "tok_1" },
    });
  });

  it("omits the optional client secret and revoke URL for client credentials when blank", () => {
    const payload = buildConnectionPayload({ ...base, auth_type: "oauth2_client_credentials", client_secret: "", client_id: "id", token_url: "https://t.example/token", id_field: "" });
    expect(payload.credentials).toEqual({});
    expect(payload.config.oauth).toEqual({ client_id: "id", token_url: "https://t.example/token", scopes: [] });
  });
});
