import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReauthProvider } from "@/components/reauth-provider";
import { ApiKeysPage, groupScopes } from "@/components/settings/integrations/api-keys-page";
import { ToastProvider } from "@/components/ui/toast";
import type { ApiCredential } from "@/lib/api/integrations";
import type { Session } from "@/lib/api/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/settings/integrations/api-keys",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/api/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/integrations")>();
  return { ...actual, listApiCredentials: vi.fn(), getIntegrationOptions: vi.fn(), createApiCredential: vi.fn(), revokeApiCredential: vi.fn() };
});

const SESSION = { active: { membership_id: "m1", permissions: { "integrations.view": "all", "integrations.manage": "all" } } } as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { createApiCredential, getIntegrationOptions, listApiCredentials, revokeApiCredential } from "@/lib/api/integrations";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const FULL_KEY = "keel_1a2b3c_full_secret_value";

const KEY: ApiCredential = {
  id: "k1",
  name: "Zapier",
  display_key: "keel_1a2b3c_••••",
  scopes: ["contacts:read"],
  status: "active",
  created_by: { id: "m1", display_name: "Ada" },
  created_at: "2026-09-01T00:00:00Z",
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
};

const SCOPES = [
  { key: "contacts:read", label: "Read contacts" },
  { key: "contacts:write", label: "Create and update contacts" },
  { key: "deals:read", label: "Read deals" },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReauthProvider>
          <ApiKeysPage />
        </ReauthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { client };
}

describe("ApiKeysPage", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    vi.mocked(createApiCredential).mockReset();
    vi.mocked(revokeApiCredential).mockReset();
    vi.mocked(listApiCredentials).mockReset().mockResolvedValue({ next: null, previous: null, results: [KEY] });
    vi.mocked(getIntegrationOptions).mockReset().mockResolvedValue({
      entities: [],
      directions: [],
      conflict_strategies: [],
      sync_intervals: [0],
      webhook_event_types: [],
      api_scopes: SCOPES,
      api_key_max_days: 365,
      oauth_redirect_uri: "",
    });
  });

  it("lists keys by their masked display key and never the full key", async () => {
    renderPage();

    expect(await screen.findByText("Zapier")).toBeInTheDocument();
    expect(screen.getByText("keel_1a2b3c_••••")).toBeInTheDocument();
    expect(await screen.findByText("Read contacts")).toBeInTheDocument();
    expect(screen.getByText("Never used")).toBeInTheDocument();
  });

  it("creates a key with grouped scopes and reveals the full key once with a usage hint", async () => {
    vi.mocked(createApiCredential).mockResolvedValue({ ...KEY, id: "k2", name: "Warehouse", scopes: ["contacts:read", "deals:read"], key: FULL_KEY });
    const user = userEvent.setup();
    const { client } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API key" });
    await user.type(within(dialog).getByLabelText("Name"), "Warehouse");
    expect(within(dialog).getByRole("group", { name: "Contacts" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "Read contacts" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Read deals" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Expires" }));
    await user.click(await screen.findByRole("option", { name: "Never expires" }));
    expect(within(dialog).getByText(/never expires stays valid until someone revokes it/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(createApiCredential).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createApiCredential).mock.calls[0]?.[0]).toEqual({ name: "Warehouse", scopes: ["contacts:read", "deals:read"], expires_in_days: null });

    const reveal = await screen.findByRole("dialog", { name: "API key “Warehouse” created" });
    expect(within(reveal).getByText(FULL_KEY)).toBeInTheDocument();
    expect(within(reveal).getByLabelText("API key usage")).toHaveTextContent("Authorization: Bearer <key>");
    expect(within(reveal).getByLabelText("API key usage")).toHaveTextContent("/api/v1/activities/");
    const cached = JSON.stringify([client.getQueryCache().getAll().map((q) => q.state.data), client.getMutationCache().getAll().map((m) => m.state.data)]);
    expect(cached).not.toContain(FULL_KEY);

    await user.click(within(reveal).getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByText(FULL_KEY)).not.toBeInTheDocument());
  });

  it("sends the default 90-day expiry", async () => {
    vi.mocked(createApiCredential).mockResolvedValue({ ...KEY, id: "k3", key: FULL_KEY });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API key" });
    await user.type(within(dialog).getByLabelText("Name"), "Zapier 2");
    await user.click(within(dialog).getByRole("checkbox", { name: "Read contacts" }));
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(createApiCredential).toHaveBeenCalledWith({ name: "Zapier 2", scopes: ["contacts:read"], expires_in_days: 90 }));
  });

  it("revokes a key after confirmation with DELETE", async () => {
    vi.mocked(revokeApiCredential).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Revoke Zapier" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke Zapier?" });
    expect(revokeApiCredential).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Revoke key" }));

    await waitFor(() => expect(revokeApiCredential).toHaveBeenCalledWith("k1"));
    expect(await screen.findByText("API key revoked")).toBeInTheDocument();
  });
});

describe("groupScopes", () => {
  it("groups by resource in server order", () => {
    expect(groupScopes(SCOPES).map((g) => [g.label, g.scopes.map((s) => s.key)])).toEqual([
      ["Contacts", ["contacts:read", "contacts:write"]],
      ["Deals", ["deals:read"]],
    ]);
  });
});
