import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReauthProvider } from "@/components/reauth-provider";
import { WebhooksPage } from "@/components/settings/integrations/webhooks-page";
import { ToastProvider } from "@/components/ui/toast";
import type { WebhookSubscription } from "@/lib/api/integrations";
import { ApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/settings/integrations/webhooks",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/api/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/integrations")>();
  return {
    ...actual,
    listWebhooks: vi.fn(),
    getIntegrationOptions: vi.fn(),
    createWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    pauseWebhook: vi.fn(),
    resumeWebhook: vi.fn(),
    testWebhook: vi.fn(),
    listWebhookDeliveries: vi.fn(),
  };
});

const perms = vi.hoisted(() => ({ value: { "integrations.view": "all", "webhooks.manage": "all" } as Record<string, string> }));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: { active: { membership_id: "m1", permissions: perms.value } } as unknown as Session }) };
});

import { createWebhook, getIntegrationOptions, listWebhooks } from "@/lib/api/integrations";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SECRET = "whsec_test_only_value_123";

const SUBSCRIPTION: WebhookSubscription = {
  id: "w1",
  name: "Data warehouse",
  url: "https://hooks.example.com/keel",
  event_types: ["contact.created"],
  include_data: false,
  status: "active",
  consecutive_failures: 0,
  last_success_at: null,
  last_failure_at: null,
  last_error_code: "",
  rotation_in_progress: false,
  created_by: { id: "m1", display_name: "Ada" },
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReauthProvider>
          <WebhooksPage />
        </ReauthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { client };
}

describe("WebhooksPage", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    perms.value = { "integrations.view": "all", "webhooks.manage": "all" };
    vi.mocked(createWebhook).mockReset();
    vi.mocked(listWebhooks).mockReset().mockResolvedValue({ next: null, previous: null, results: [] });
    vi.mocked(getIntegrationOptions).mockReset().mockResolvedValue({
      entities: [],
      directions: [],
      conflict_strategies: [],
      sync_intervals: [0],
      webhook_event_types: ["contact.created", "deal.stage_changed"],
      api_scopes: [],
      api_key_max_days: 365,
      oauth_redirect_uri: "",
    });
  });

  it("creates a webhook with least data by default and reveals the signing secret only once", async () => {
    vi.mocked(createWebhook).mockResolvedValue({ ...SUBSCRIPTION, secret: SECRET });
    const user = userEvent.setup();
    const { client } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Add webhook" }));
    const dialog = await screen.findByRole("dialog", { name: "Add webhook" });
    await user.type(within(dialog).getByLabelText("Name"), "Data warehouse");
    await user.type(within(dialog).getByLabelText("Endpoint URL"), "https://hooks.example.com/keel");
    await user.click(within(dialog).getByRole("checkbox", { name: /Deal stage changed/ }));
    expect(within(dialog).getByRole("switch", { name: "Include record fields" })).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Create webhook" }));

    await waitFor(() => expect(createWebhook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createWebhook).mock.calls[0]?.[0]).toEqual({
      name: "Data warehouse",
      url: "https://hooks.example.com/keel",
      event_types: ["deal.stage_changed"],
      include_data: false,
    });

    const reveal = await screen.findByRole("dialog", { name: "Webhook “Data warehouse” created" });
    expect(within(reveal).getByText(SECRET)).toBeInTheDocument();
    expect(within(reveal).getByText(/will not be shown again/)).toBeInTheDocument();

    // Neither the query cache nor the mutation cache ever holds the secret.
    const cached = JSON.stringify([client.getQueryCache().getAll().map((q) => q.state.data), client.getMutationCache().getAll().map((m) => m.state.data)]);
    expect(cached).not.toContain(SECRET);

    await user.click(within(reveal).getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("requires an https URL and at least one event, and shows server URL errors inline", async () => {
    vi.mocked(createWebhook).mockRejectedValue(
      new ApiError({ type: "validation_error", title: "Invalid request", status: 400, errors: [{ field: "url", code: "invalid", message: "This address points to a private network and is not allowed." }] }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Add webhook" }));
    const dialog = await screen.findByRole("dialog", { name: "Add webhook" });
    await user.type(within(dialog).getByLabelText("Name"), "Local");
    await user.type(within(dialog).getByLabelText("Endpoint URL"), "http://localhost/hook");
    await user.click(within(dialog).getByRole("button", { name: "Create webhook" }));
    expect(await within(dialog).findByText("Use a public https:// address.")).toBeInTheDocument();
    expect(within(dialog).getByText("Choose at least one event.")).toBeInTheDocument();
    expect(createWebhook).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText("Endpoint URL"));
    await user.type(within(dialog).getByLabelText("Endpoint URL"), "https://10.0.0.1/hook");
    await user.click(within(dialog).getByRole("checkbox", { name: /Contact created/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create webhook" }));
    expect(await within(dialog).findByText("This address points to a private network and is not allowed.")).toBeInTheDocument();
    expect(screen.queryByText(/signing secret/i)).not.toBeInTheDocument();
  });

  it("lists subscriptions with a readable status", async () => {
    vi.mocked(listWebhooks).mockResolvedValue({
      next: null,
      previous: null,
      results: [{ ...SUBSCRIPTION, status: "disabled", last_failure_at: "2026-09-10T10:00:00Z", last_error_code: "timeout" }],
    });
    renderPage();

    expect(await screen.findByText("Data warehouse")).toBeInTheDocument();
    expect(screen.getByText("Turned off after failures")).toBeInTheDocument();
    expect(screen.getByText("The receiving system did not respond in time.")).toBeInTheDocument();
    expect(screen.queryByText("timeout")).not.toBeInTheDocument();
  });

  it("explains the missing permission instead of loading webhooks", async () => {
    perms.value = { "integrations.view": "all" };
    renderPage();

    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add webhook" })).not.toBeInTheDocument();
    expect(listWebhooks).not.toHaveBeenCalled();
  });
});
