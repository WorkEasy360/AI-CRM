import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantProvider, Conversation, useAssistant } from "@/components/assistant/ask-keel";
import type { AssistantActionProposal, AssistantAnswer } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  askKeel: vi.fn(),
  getAssistantHome: vi.fn(async () => ({ suggestions: [], generative_available: true, knowledge_available: true, recent: [] })),
  getAssistantConversation: vi.fn(),
  deleteAssistantConversation: vi.fn(),
  getHelpArticle: vi.fn(),
  getHelpSuggestions: vi.fn(async () => ({ suggestions: [] })),
  sendHelpFeedback: vi.fn(),
  createPipeline: vi.fn(),
  archivePipeline: vi.fn(),
  createActivity: vi.fn(),
  deleteActivity: vi.fn(),
  createDeal: vi.fn(),
  createContact: vi.fn(),
  createCompany: vi.fn(),
  archiveRecord: vi.fn(),
}));
vi.mock("@/lib/api/helpdesk", () => ({ createTicket: vi.fn(), deleteTicket: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/dashboard", useSearchParams: () => new URLSearchParams() }));

const SESSION = {
  user: { id: "u1", email: "owner@example.com", display_name: "Owner" },
  active: { membership_id: "m1", organization: { id: "o1", name: "Acme", base_currency: "INR" }, permissions: { "ai.assistant.use": "all", "pipelines.manage": "all" } },
} as unknown as Session;
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { archivePipeline, askKeel, createPipeline } from "@/lib/api/crm";

function answerWith(action: AssistantActionProposal): AssistantAnswer {
  return {
    conversation_id: "c1",
    question: "Create a pipeline called Enterprise Sales",
    intent: "action_request",
    mode: "retrieval",
    answer_type: "action",
    headline: "Creating the pipeline “Enterprise Sales”.",
    facts: [],
    analysis: "",
    recommendation: "",
    sections: [],
    sources: [],
    suggestions: [],
    action,
  } as unknown as AssistantAnswer;
}

const PIPELINE: AssistantActionProposal = { kind: "pipeline", title: "Enterprise Sales", due_date: "", links: {}, permission_ok: true, ready: true };

function Harness() {
  const assistant = useAssistant()!;
  React.useEffect(() => assistant.setInline(true), [assistant]);
  return (
    <>
      <button type="button" onClick={() => assistant.submit("Create a pipeline called Enterprise Sales")}>
        Ask
      </button>
      <Conversation turns={assistant.turns} currency="INR" busy={assistant.busy} onAsk={assistant.submit} />
    </>
  );
}

function renderHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AssistantProvider>
        <Harness />
      </AssistantProvider>
    </QueryClientProvider>,
  );
}

describe("assistant actions", () => {
  beforeEach(() => {
    vi.mocked(createPipeline).mockReset();
    vi.mocked(archivePipeline).mockReset();
  });

  it("creates a ready request once through the normal API, then links to it and can undo it", async () => {
    vi.mocked(askKeel).mockResolvedValue(answerWith(PIPELINE));
    vi.mocked(createPipeline).mockResolvedValue({ id: "p9", name: "Enterprise Sales" } as never);
    vi.mocked(archivePipeline).mockResolvedValue(undefined as never);
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/Created pipeline “Enterprise Sales”/)).toBeInTheDocument();
    expect(createPipeline).toHaveBeenCalledTimes(1);
    expect(createPipeline).toHaveBeenCalledWith({ name: "Enterprise Sales" });
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute("href", "/pipeline?pipeline=p9");

    await user.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(archivePipeline).toHaveBeenCalledWith("p9"));
    expect(await screen.findByText(/Undone/)).toBeInTheDocument();
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal and offers the manual route instead", async () => {
    vi.mocked(askKeel).mockResolvedValue(answerWith(PIPELINE));
    vi.mocked(createPipeline).mockRejectedValue(new Error("A pipeline with this name already exists."));
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/);
    expect(screen.getByRole("link", { name: /Open pipeline settings/ })).toHaveAttribute("href", "/settings/pipelines");
  });

  it("never creates when the request is not ready or not permitted", async () => {
    vi.mocked(askKeel).mockResolvedValue(answerWith({ ...PIPELINE, title: "", ready: false }));
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByRole("link", { name: /Open pipeline settings/ })).toBeInTheDocument();
    expect(createPipeline).not.toHaveBeenCalled();
  });
});
