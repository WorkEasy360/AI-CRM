import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type { Session } from "@/lib/api/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/settings/ai/knowledge-base" }));
vi.mock("@/lib/api/endpoints", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/api/crm", () => ({
  listHelpAdminArticles: vi.fn(),
  listHelpUnanswered: vi.fn(),
  getHelpReport: vi.fn(),
  createHelpArticle: vi.fn(),
  saveHelpArticle: vi.fn(),
  deleteHelpArticle: vi.fn(),
  getHelpAdminArticle: vi.fn(),
  listHelpRevisions: vi.fn(),
  restoreHelpRevision: vi.fn(),
  setHelpUnansweredStatus: vi.fn(),
}));

import { createHelpArticle, listHelpAdminArticles, listHelpUnanswered } from "@/lib/api/crm";
import { getSession } from "@/lib/api/endpoints";
import { KnowledgeBasePage } from "./knowledge-base-page";

function sessionWith(permissions: Record<string, string>): Session {
  return {
    user: { id: "u1", email: "admin@example.com", display_name: "Admin" },
    mfa_enabled: false,
    recently_authenticated: true,
    memberships: [],
    active: {
      membership_id: "m1",
      organization: { id: "o1", name: "Acme", slug: "acme", base_currency: "INR", timezone: "Asia/Kolkata", plan: "trial", status: "active", require_mfa: false, created_at: "2026-01-01T00:00:00Z" },
      role: { key: "admin", name: "Admin" },
      permissions,
      mfa_required: false,
    },
  } as Session;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <KnowledgeBasePage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("KnowledgeBasePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listHelpAdminArticles).mockResolvedValue({
      workspace: [],
      global: [{ id: "pipeline-create", title: "How to Create a New Pipeline", module: "Pipeline", customized: false }],
      modules: ["Pipeline"],
    });
    vi.mocked(listHelpUnanswered).mockResolvedValue({
      results: [{ id: "q1", question: "How do we qualify a lead", page: "/contacts", times_asked: 3, last_asked_at: "2026-11-06T10:00:00Z", status: "open", article_slug: "" }],
    });
  });

  it("is closed to members without the AI settings permission", async () => {
    vi.mocked(getSession).mockResolvedValue(sessionWith({ "ai.assistant.use": "all" }));
    renderPage();
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(listHelpAdminArticles).not.toHaveBeenCalled();
  });

  it("lists the guide and turns an unanswered question into an article", async () => {
    vi.mocked(getSession).mockResolvedValue(sessionWith({ "ai.settings.manage": "all" }));
    vi.mocked(createHelpArticle).mockResolvedValue({ status: "draft" } as never);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("How to Create a New Pipeline")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Unanswered Questions" }));
    const row = (await screen.findByText("How do we qualify a lead")).closest("tr");
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Create article" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Question it answers")).toHaveValue("How do we qualify a lead?");
    expect(within(dialog).getByLabelText("Page (route)")).toHaveValue("/contacts");
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(createHelpArticle).toHaveBeenCalled());
    const input = vi.mocked(createHelpArticle).mock.calls[0]?.[0];
    expect(input).toMatchObject({ slug: "how-do-we-qualify-a-lead", from_unanswered: "q1", status: "draft", route: "/contacts" });
  });
});
