import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AskKeelCard } from "@/components/assistant/ask-keel";
import type { AssistantAnswer, AssistantHome } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  askKeel: vi.fn(),
  getAssistantHome: vi.fn(),
  deleteAssistantConversation: vi.fn(),
}));

vi.mock("@/lib/api/endpoints", () => ({ getSession: vi.fn() }));

import { askKeel, getAssistantHome } from "@/lib/api/crm";
import { getSession } from "@/lib/api/endpoints";

const organization = {
  id: "o1",
  name: "Acme",
  slug: "acme",
  base_currency: "INR",
  timezone: "Asia/Kolkata",
  plan: "trial",
  status: "active",
  require_mfa: false,
  created_at: "2026-01-01T00:00:00Z",
};

const session: Session = {
  user: { id: "u1", email: "owner@example.com", display_name: "Owner" },
  mfa_enabled: false,
  recently_authenticated: true,
  memberships: [],
  active: {
    membership_id: "m1",
    organization,
    role: { key: "owner", name: "Owner" },
    permissions: {},
    mfa_required: false,
  },
};

const home: AssistantHome = {
  suggestions: ["Which deals need attention?", "Summarize my pipeline."],
  generative_available: true,
  knowledge_available: true,
  recent: [],
};

const aiAnswer: AssistantAnswer = {
  conversation_id: "c1",
  question: "What happened with ABC Corp?",
  intent: "customer_history",
  mode: "ai",
  answer_type: "summary",
  headline: "ABC Corp has one open deal in Proposal.",
  facts: ["Open deal 'Enterprise Expansion': 850000.00 INR, stage Proposal, probability 40%."],
  analysis: "Engagement has slowed since the proposal was sent.",
  recommendation: "Follow up with the decision maker.",
  sections: [
    {
      title: "Deals",
      kind: "records",
      hint: "",
      items: [
        {
          id: "d1",
          type: "deal",
          title: "Enterprise Expansion",
          subtitle: "Proposal",
          meta: "40%",
          amount: "850000.00",
          currency: "INR",
          href: "/deals/d1",
        },
      ],
    },
  ],
  sources: [
    { type: "company", id: "co1", title: "ABC Corp", subtitle: "Company", occurred_at: null, href: "/companies/co1" },
    { type: "email", id: "e1", title: "ABC Corp", subtitle: "Email", occurred_at: "2026-09-11T09:00:00Z", href: "/companies/co1" },
  ],
  suggestions: ["What are the risks on ABC Corp?"],
  notice: "",
  knowledge_search_only: false,
};

const fallbackAnswer: AssistantAnswer = {
  ...aiAnswer,
  mode: "retrieval",
  analysis: "",
  knowledge_search_only: true,
  notice: "AI analysis is temporarily unavailable. The information above was retrieved directly from your CRM.",
  sections: [
    ...aiAnswer.sections,
    {
      title: "From your conversations",
      kind: "events",
      hint: "Quoted from your CRM records",
      items: [
        {
          id: "k1",
          type: "activity",
          label: "Meeting",
          title: "ABC Corp",
          snippet: "Customer requested revised pricing.",
          occurred_at: "2026-09-13T09:00:00Z",
          href: "/deals/d1",
        },
      ],
    },
  ],
};

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AskKeelCard />
    </QueryClientProvider>,
  );
}

describe("Ask Keel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getAssistantHome).mockResolvedValue(home);
    vi.mocked(askKeel).mockResolvedValue(aiAnswer);
  });

  it("offers one entry point with suggested questions", async () => {
    renderCard();
    expect(await screen.findByRole("heading", { name: "Ask Keel" })).toBeInTheDocument();
    expect(screen.getByLabelText("Ask Keel a question")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Summarize my pipeline." })).toBeInTheDocument();
    // There is no separate AI search / RAG search / chat surface to choose between.
    expect(screen.queryByText(/RAG/i)).not.toBeInTheDocument();
  });

  it("answers in a panel, keeping facts, analysis and advice apart", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText("Ask Keel a question"), "What happened with ABC Corp?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("ABC Corp has one open deal in Proposal.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "From your CRM" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Keel's analysis" })).toHaveTextContent("Engagement has slowed");
    expect(screen.getByRole("region", { name: "Recommended next step" })).toHaveTextContent("decision maker");
    // Money is formatted for the viewer, from the server's exact figure.
    expect(screen.getByText(/8,50,000|850,000/)).toBeInTheDocument();
  });

  it("shows sources as links to the records they came from", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText("Ask Keel a question"), "What happened with ABC Corp?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    const sources = await screen.findByRole("region", { name: "Sources" });
    expect(sources).toHaveTextContent("Company");
    expect(sources).toHaveTextContent("Email");
    const link = screen.getAllByRole("link", { name: /ABC Corp/ })[0];
    expect(link).toHaveAttribute("href", "/companies/co1");
  });

  it("looks the same when no model answered, and still shows the CRM information", async () => {
    vi.mocked(askKeel).mockResolvedValue(fallbackAnswer);
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText("Ask Keel a question"), "What happened with ABC Corp?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    // Same headline, same facts, same sources: only the written analysis is missing.
    expect(await screen.findByText("ABC Corp has one open deal in Proposal.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "From your CRM" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Keel's analysis" })).not.toBeInTheDocument();
    expect(screen.getByText(/Customer requested revised pricing/)).toBeInTheDocument();
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
    // No provider names, no status codes.
    expect(screen.queryByText(/anthropic|503|api/i)).not.toBeInTheDocument();
  });

  it("says knowledge search mode when the workspace has generative AI switched off", async () => {
    vi.mocked(getAssistantHome).mockResolvedValue({ ...home, generative_available: false });
    renderCard();
    expect(await screen.findAllByText("Knowledge search mode")).not.toHaveLength(0);
  });

  it("continues the same conversation for a follow-up question", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Which deals need attention?" }));
    await screen.findByText("ABC Corp has one open deal in Proposal.");

    // Scoped to the open panel: a detached portal from an earlier render must not be clicked.
    const panel = within(screen.getByRole("dialog"));
    await user.click(await panel.findByRole("button", { name: "What are the risks on ABC Corp?" }));
    await waitFor(() => expect(vi.mocked(askKeel)).toHaveBeenCalledTimes(2));
    // The first question starts a thread; the follow-up continues it, so "next" knows what "it" is.
    expect(vi.mocked(askKeel).mock.calls.at(0)?.[0]).toMatchObject({ conversation_id: null });
    expect(vi.mocked(askKeel).mock.calls.at(1)?.[0]).toMatchObject({ conversation_id: "c1" });
  });

  it("surfaces an error without losing the question", async () => {
    vi.mocked(askKeel).mockRejectedValue(new Error("Network down"));
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText("Ask Keel a question"), "What happened with ABC Corp?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("What happened with ABC Corp?")).toBeInTheDocument();
  });
});
