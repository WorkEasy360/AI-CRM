import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_HINT, WhatsAppDialog } from "@/components/messaging/whatsapp-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { WhatsAppMessage, WhatsAppTemplate, WhatsAppWindow } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  whatsAppWindow: vi.fn(),
  listWhatsAppTemplates: vi.fn(),
  sendWhatsApp: vi.fn(),
  generateFollowUp: vi.fn(),
}));

const SESSION = {
  active: { membership_id: "m1", permissions: { "whatsapp.send": "all", "whatsapp.view": "all", "whatsapp.manage": "all", "ai.copilot.use": "all" } },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { generateFollowUp, listWhatsAppTemplates, sendWhatsApp, whatsAppWindow } from "@/lib/api/crm";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const CONTACT = { id: "c1", name: "Ada Lovelace", phone: "+1 555 0100", whatsapp_opt_in: true };
const OPEN: WhatsAppWindow = { open: true, reason: "", last_inbound_at: "2026-09-13T10:00:00Z", opt_in: true, connected: true };
const CLOSED: WhatsAppWindow = { open: false, reason: "no_inbound", last_inbound_at: null, opt_in: true, connected: true };
const TEMPLATE: WhatsAppTemplate = {
  id: "t1",
  name: "meeting_reminder",
  language: "en",
  category: "UTILITY",
  body: "Hi {{1}}, see you on {{2}}.",
  parameter_count: 2,
  status: "approved",
  created_at: "2026-09-01T00:00:00Z",
};
const QUEUED = { id: "w1", status: "queued", direction: "outbound" } as unknown as WhatsAppMessage;

function renderDialog(props: Partial<React.ComponentProps<typeof WhatsAppDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <WhatsAppDialog open onOpenChange={onOpenChange} contact={CONTACT} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe("WhatsAppDialog", () => {
  beforeEach(() => {
    vi.mocked(whatsAppWindow).mockReset();
    vi.mocked(sendWhatsApp).mockReset();
    vi.mocked(generateFollowUp).mockReset();
    vi.mocked(listWhatsAppTemplates).mockReset().mockResolvedValue({ next: null, previous: null, results: [TEMPLATE] });
  });

  it("sends free text while the 24-hour window is open", async () => {
    vi.mocked(whatsAppWindow).mockResolvedValue(OPEN);
    vi.mocked(sendWhatsApp).mockResolvedValue(QUEUED);
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ deal: { id: "d1", name: "Engine" } });

    await user.type(await screen.findByLabelText("Message"), "Hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sendWhatsApp).toHaveBeenCalledTimes(1));
    expect(sendWhatsApp).toHaveBeenCalledWith({ contact_id: "c1", deal_id: "d1", message_type: "text", body: "Hello there", ai_assisted: false });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("inserts an AI draft as reviewable text and flags it as AI-assisted", async () => {
    vi.mocked(whatsAppWindow).mockResolvedValue(OPEN);
    vi.mocked(generateFollowUp).mockResolvedValue({ draft: "Hi Ada, quick nudge on the proposal.", style: "short", channel: "whatsapp", sources: [], flagged_input: false });
    vi.mocked(sendWhatsApp).mockResolvedValue(QUEUED);
    const user = userEvent.setup();
    renderDialog();

    await screen.findByLabelText("Message");
    await user.click(screen.getByRole("button", { name: "Draft with AI" }));

    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Hi Ada, quick nudge on the proposal."));
    expect(generateFollowUp).toHaveBeenCalledWith({ entity_type: "contact", entity_id: "c1", tone: "short", channel: "whatsapp" });
    expect(screen.getByText(/Draft by AI/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ message_type: "text", ai_assisted: true })));
  });

  it("switches to template mode when the window is closed and blocks sending without consent", async () => {
    vi.mocked(whatsAppWindow).mockResolvedValue({ ...CLOSED, opt_in: false });
    renderDialog({ contact: { ...CONTACT, whatsapp_opt_in: false } });

    expect(await screen.findByText(new RegExp(CONSENT_HINT.replace(".", "\\.")))).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(screen.getByText(/only allows free-text replies within 24 hours/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send template" })).toBeDisabled());
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });

  it("sends the preselected approved template with its parameters when the contact has opted in", async () => {
    vi.mocked(whatsAppWindow).mockResolvedValue(CLOSED);
    vi.mocked(sendWhatsApp).mockResolvedValue(QUEUED);
    const user = userEvent.setup();
    renderDialog();

    await user.type(await screen.findByLabelText("Value for {{1}}"), "Ada");
    await user.type(screen.getByLabelText("Value for {{2}}"), "Friday");
    expect(screen.getByText("Hi Ada, see you on Friday.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send template" }));
    await waitFor(() => expect(sendWhatsApp).toHaveBeenCalledTimes(1));
    expect(sendWhatsApp).toHaveBeenCalledWith({ contact_id: "c1", deal_id: null, message_type: "template", template_id: "t1", template_params: ["Ada", "Friday"] });
  });

  it("explains when WhatsApp is not connected and links admins to settings", async () => {
    vi.mocked(whatsAppWindow).mockResolvedValue({ ...CLOSED, connected: false });
    renderDialog();

    expect(await screen.findByText(/WhatsApp is not connected/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings → WhatsApp/ })).toHaveAttribute("href", "/settings/whatsapp");
    expect(screen.getByRole("button", { name: "Send template" })).toBeDisabled();
  });
});
