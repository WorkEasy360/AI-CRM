import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReauthProvider } from "@/components/reauth-provider";
import { allowedFields, SharingEditor } from "@/components/settings/integrations/sharing-editor";
import { ToastProvider } from "@/components/ui/toast";
import type { ConnectionDetail, IntegrationOptions } from "@/lib/api/integrations";
import { ApiError } from "@/lib/api/problem";

vi.mock("@/lib/api/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/integrations")>();
  return { ...actual, updateConnectionSharing: vi.fn() };
});

import { updateConnectionSharing } from "@/lib/api/integrations";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const OPTIONS: IntegrationOptions = {
  entities: [
    {
      key: "contact",
      label: "Contacts",
      shareable: true,
      reason: "",
      outbound_fields: ["first_name", "last_name", "email", "custom.industry_code"],
      inbound_fields: ["first_name", "last_name", "email", "phone"],
      inbound_create: true,
    },
    { key: "note", label: "Notes", shareable: false, reason: "Internal notes are never shared." },
  ],
  directions: [
    { key: "none", label: "Not shared" },
    { key: "outbound", label: "CRM → External" },
    { key: "inbound", label: "External → CRM" },
    { key: "two_way", label: "Two-way" },
  ],
  conflict_strategies: [{ key: "manual", label: "Manual resolution" }],
  sync_intervals: [0, 60],
  webhook_event_types: [],
  api_scopes: [],
  api_key_max_days: 365,
  oauth_redirect_uri: "https://app.example.com/api/v1/integrations/oauth/callback/",
};

const CONNECTION: ConnectionDetail = {
  id: "c1",
  provider: "generic_rest",
  provider_name: "Generic REST API",
  name: "Marketing platform",
  status: "connected",
  status_message: "Connected",
  auth_type: "api_key",
  config: { base_url: "https://api.example.com" },
  credentials_configured: ["api_key"],
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
};

function renderEditor(connection: ConnectionDetail = CONNECTION, canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReauthProvider>
          <SharingEditor connection={connection} options={OPTIONS} canManage={canManage} />
        </ReauthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("SharingEditor", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    vi.mocked(updateConnectionSharing).mockReset();
  });

  it("shows non-shareable data disabled with the reason", () => {
    renderEditor();

    expect(screen.getByRole("combobox", { name: "Notes sharing direction" })).toBeDisabled();
    expect(screen.getByText("Internal notes are never shared.")).toBeInTheDocument();
    expect(screen.getByText("Never shared")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Contacts sharing direction" })).toBeEnabled();
  });

  it("offers only fields allowed in both directions for two-way sharing", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("combobox", { name: "Contacts sharing direction" }));
    await user.click(await screen.findByRole("option", { name: "Two-way" }));
    await user.click(screen.getByRole("combobox", { name: "Contacts CRM field 1" }));

    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["First name", "Last name", "Email"]);
  });

  it("saves a policy with a PUT of direction, API path and mappings", async () => {
    vi.mocked(updateConnectionSharing).mockImplementation(async (_id, policy) => ({ ...CONNECTION, sharing: [policy] }));
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole("combobox", { name: "Contacts sharing direction" }));
    await user.click(await screen.findByRole("option", { name: "Two-way" }));
    await user.type(screen.getByLabelText("API path"), "/contacts");
    await user.click(screen.getByRole("combobox", { name: "Contacts CRM field 1" }));
    await user.click(await screen.findByRole("option", { name: "Email" }));
    await user.type(screen.getByRole("textbox", { name: "Contacts external field 1" }), "emailAddress");
    await user.click(screen.getByRole("button", { name: "Save contacts" }));

    await waitFor(() => expect(updateConnectionSharing).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateConnectionSharing).mock.calls[0]).toEqual([
      "c1",
      { entity_type: "contact", direction: "two_way", external_resource: "/contacts", mappings: [{ crm_field: "email", external_field: "emailAddress" }] },
    ]);
    expect(await screen.findByText("Contacts sharing saved")).toBeInTheDocument();
  });

  it("turns sharing off with direction none and no mappings", async () => {
    vi.mocked(updateConnectionSharing).mockResolvedValue({ ...CONNECTION, sharing: [] });
    const user = userEvent.setup();
    renderEditor({
      ...CONNECTION,
      sharing: [{ entity_type: "contact", direction: "outbound", external_resource: "/people", mappings: [{ crm_field: "email", external_field: "mail" }] }],
    });

    expect(screen.getByRole("textbox", { name: "Contacts external field 1" })).toHaveValue("mail");
    await user.click(screen.getByRole("combobox", { name: "Contacts sharing direction" }));
    await user.click(await screen.findByRole("option", { name: "Not shared" }));
    await user.click(screen.getByRole("button", { name: "Save contacts" }));

    await waitFor(() => expect(updateConnectionSharing).toHaveBeenCalledWith("c1", { entity_type: "contact", direction: "none", external_resource: "", mappings: [] }));
  });

  it("shows every mapping error from a 400 response", async () => {
    vi.mocked(updateConnectionSharing).mockRejectedValue(
      new ApiError({
        type: "validation_error",
        title: "Invalid request",
        status: 400,
        errors: [
          { field: "mappings", code: "invalid", message: "email: not available for two-way sharing." },
          { field: "mappings", code: "invalid", message: "email → emailAddress: each field can be mapped once." },
          { field: "external_resource", code: "invalid", message: "Enter the API path for this data, for example /contacts." },
        ],
      }),
    );
    const user = userEvent.setup();
    renderEditor({
      ...CONNECTION,
      sharing: [{ entity_type: "contact", direction: "outbound", external_resource: "/people", mappings: [{ crm_field: "email", external_field: "mail" }] }],
    });

    await user.clear(screen.getByRole("textbox", { name: "Contacts external field 1" }));
    await user.type(screen.getByRole("textbox", { name: "Contacts external field 1" }), "emailAddress");
    await user.click(screen.getByRole("button", { name: "Save contacts" }));

    expect(await screen.findByText("email: not available for two-way sharing.")).toBeInTheDocument();
    expect(screen.getByText("email → emailAddress: each field can be mapped once.")).toBeInTheDocument();
    expect(screen.getByText("Enter the API path for this data, for example /contacts.")).toBeInTheDocument();
    expect(screen.getByLabelText("API path")).toHaveAttribute("aria-invalid", "true");
  });

  it("is read-only without manage permission", () => {
    renderEditor(
      { ...CONNECTION, sharing: [{ entity_type: "contact", direction: "outbound", external_resource: "/people", mappings: [{ crm_field: "email", external_field: "mail" }] }] },
      false,
    );
    expect(screen.getByRole("combobox", { name: "Contacts sharing direction" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Contacts external field 1" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save contacts" })).not.toBeInTheDocument();
  });
});

describe("allowedFields", () => {
  const contact = OPTIONS.entities[0]!;
  it("uses the outbound, inbound or intersecting allowlist", () => {
    expect(allowedFields(contact, "outbound")).toEqual(["first_name", "last_name", "email", "custom.industry_code"]);
    expect(allowedFields(contact, "inbound")).toEqual(["first_name", "last_name", "email", "phone"]);
    expect(allowedFields(contact, "two_way")).toEqual(["first_name", "last_name", "email"]);
    expect(allowedFields(contact, "none")).toEqual([]);
  });
});
