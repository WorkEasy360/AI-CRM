import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailComposerDialog } from "@/components/messaging/email-composer-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { EmailMessage } from "@/lib/api/crm-types";
import { ApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  listEmailTemplates: vi.fn(),
  renderEmailTemplate: vi.fn(),
  sendEmail: vi.fn(),
  draftEmailWithAI: vi.fn(),
}));

const SESSION = {
  active: { membership_id: "m1", permissions: { "email.send": "all", "email.view": "all", "ai.copilot.use": "all" } },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { draftEmailWithAI, listEmailTemplates, sendEmail } from "@/lib/api/crm";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const EMPTY_PAGE = { next: null, previous: null, results: [] };
const CONTACT = { id: "c1", name: "Ada Lovelace", email: "ada@example.com" };
const DEAL = { id: "d1", name: "Analytical engine" };

const QUEUED = { id: "e1", status: "queued", direction: "outbound" } as unknown as EmailMessage;

function renderDialog(props: Partial<React.ComponentProps<typeof EmailComposerDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  const onSent = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <EmailComposerDialog open onOpenChange={onOpenChange} contact={CONTACT} deal={DEAL} onSent={onSent} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange, onSent };
}

describe("EmailComposerDialog", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockReset();
    vi.mocked(draftEmailWithAI).mockReset();
    vi.mocked(listEmailTemplates).mockReset().mockResolvedValue(EMPTY_PAGE);
  });

  it("prefills the contact address and sends with the linked record ids", async () => {
    vi.mocked(sendEmail).mockResolvedValue(QUEUED);
    const user = userEvent.setup();
    const { onOpenChange, onSent } = renderDialog();

    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Subject"), "Next steps");
    await user.type(screen.getByLabelText("Message"), "Hello Ada");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["ada@example.com"], subject: "Next steps", body: "Hello Ada", contact_id: "c1", deal_id: "d1", company_id: null, ai_assisted: false }),
      [],
    );
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(QUEUED));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await screen.findByText("Email queued")).toBeInTheDocument();
  });

  it("requires a recipient and a body before calling the API", async () => {
    const user = userEvent.setup();
    renderDialog({ contact: null, deal: null });

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Add at least one recipient.")).toBeInTheDocument();
    expect(screen.getByText("Write a message before sending.")).toBeInTheDocument();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("shows the not-connected notice with a link to settings on 409", async () => {
    vi.mocked(sendEmail).mockRejectedValue(
      new ApiError({ type: "email_not_connected", title: "Conflict", status: 409, detail: "Connect a mailbox before sending email." }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Message"), "Hello Ada");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/mailbox is not connected/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Connect a mailbox/ })).toHaveAttribute("href", "/settings/email");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("inserts an AI draft for review and marks the message as AI-assisted", async () => {
    vi.mocked(draftEmailWithAI).mockResolvedValue({
      subject: "Following up on our call",
      body: "Hi Ada,\n\nThanks for your time today.",
      purpose: "follow_up_meeting",
      tone: "professional",
      operation: "generate",
      sources: [],
      flagged_input: true,
    });
    vi.mocked(sendEmail).mockResolvedValue(QUEUED);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Write with AI" }));
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Hi Ada,\n\nThanks for your time today."));
    expect(draftEmailWithAI).toHaveBeenCalledWith(
      expect.objectContaining({ contact_id: "c1", deal_id: "d1", purpose: "follow_up_meeting", tone: "professional", operation: "generate" }),
    );
    expect(screen.getByLabelText("Subject")).toHaveValue("Following up on our call");
    expect(screen.getByText(/Draft by AI/)).toBeInTheDocument();
    expect(screen.getByText(/suspicious instructions/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ ai_assisted: true, subject: "Following up on our call" }), []);
  });

  it("renders nothing without the email.send permission", () => {
    SESSION.active!.permissions = { "email.view": "all" };
    renderDialog();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    SESSION.active!.permissions = { "email.send": "all", "email.view": "all", "ai.copilot.use": "all" };
  });
});
