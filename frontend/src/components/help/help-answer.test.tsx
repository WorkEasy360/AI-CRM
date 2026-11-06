import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpAnswer } from "@/lib/api/crm-types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/pipeline" }));
vi.mock("@/lib/api/crm", () => ({ sendHelpFeedback: vi.fn() }));
vi.mock("@/lib/spotlight", () => ({ spotlight: vi.fn() }));

import { sendHelpFeedback } from "@/lib/api/crm";
import { spotlight } from "@/lib/spotlight";
import { AnswerFeedback, HelpAnswerCard } from "./help-answer";
import { HelpMarkdown } from "./markdown";

const help: HelpAnswer = {
  found: true,
  article: {
    id: "pipeline-create",
    title: "How to Create a New Pipeline",
    question: "How do I create a pipeline?",
    module: "Pipeline",
    route: "/settings/pipelines",
    menu_path: "Settings → CRM Configuration → Pipelines & Stages",
    spotlight: "New pipeline",
    permission: "pipelines.manage",
    permission_ok: true,
    source: "global",
    updated: "2026-11-06",
  },
  summary: "A pipeline is your sales process as a series of stages.",
  content: {
    overview: "A pipeline is your sales process as a series of stages.",
    before_you_start: ["You need the **Admin** role."],
    steps: ["Click **Settings** in the left sidebar.", "Click **Pipelines & Stages**.", "Click **New pipeline**."],
    result: "The new pipeline appears in the **Pipeline selector**.",
    tips: ["Keep 5–7 stages."],
    troubleshooting: [],
  },
  text: "",
  related: [{ id: "pipeline-add-stage", title: "How to Add a Stage", question: "How do I add a stage?" }],
  language: "en",
  verified: true,
};

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("HelpAnswerCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the article's steps, menu path and result", () => {
    wrap(<HelpAnswerCard help={help} />);
    expect(screen.getByText("How to Create a New Pipeline")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Where to find it" })).toHaveTextContent(/Settings\s*then\s*CRM Configuration\s*then\s*Pipelines & Stages/);
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(steps.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByText("New pipeline", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Result" })).toHaveTextContent("Pipeline selector");
  });

  it("Take me there navigates, closes the panel and highlights the button", async () => {
    const onNavigate = vi.fn();
    wrap(<HelpAnswerCard help={help} onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole("button", { name: /Take me there/ }));
    expect(onNavigate).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/settings/pipelines");
    expect(spotlight).toHaveBeenCalledWith("New pipeline");
  });

  it("related topics ask the follow-up question", async () => {
    const onAsk = vi.fn();
    wrap(<HelpAnswerCard help={help} onAsk={onAsk} />);
    await userEvent.click(screen.getByRole("button", { name: "How to Add a Stage" }));
    expect(onAsk).toHaveBeenCalledWith("How do I add a stage?");
  });

  it("tells a member without the permission to ask an admin", () => {
    wrap(<HelpAnswerCard help={{ ...help, article: { ...help.article!, permission_ok: false } }} />);
    expect(screen.getByText(/Contact your workspace admin/)).toBeInTheDocument();
  });

  it("renders verified model text instead of the article body", () => {
    wrap(<HelpAnswerCard help={{ ...help, text: "Aap pipeline bana sakte hain.\n\n1. **Settings** par click karein." }} />);
    expect(screen.getByText(/Aap pipeline bana sakte hain/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Result" })).not.toBeInTheDocument();
  });

  it("shows the not-found message and suggestions", () => {
    wrap(<HelpAnswerCard help={{ ...help, found: false, article: null, content: null, summary: "I couldn't find this in the WorkEasy360 help guide yet." }} />);
    expect(screen.getByText(/couldn't find this/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "You might be looking for" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Take me there/ })).not.toBeInTheDocument();
  });
});

describe("AnswerFeedback", () => {
  it("sends a vote and then an optional comment", async () => {
    vi.mocked(sendHelpFeedback).mockResolvedValue({ ok: true, rating: -1 });
    wrap(<AnswerFeedback turnId="t1" />);
    await userEvent.click(screen.getByRole("button", { name: "Not helpful" }));
    expect(vi.mocked(sendHelpFeedback).mock.calls[0]?.[0]).toEqual({ turn_id: "t1", rating: -1 });
    await userEvent.type(screen.getByRole("textbox", { name: "Feedback comment" }), "Step 2 is wrong");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(vi.mocked(sendHelpFeedback).mock.calls.at(-1)?.[0]).toEqual({ turn_id: "t1", rating: -1, comment: "Step 2 is wrong" }));
    expect(await screen.findByText("Thanks for the feedback.")).toBeInTheDocument();
  });
});

describe("HelpMarkdown", () => {
  it("never renders HTML from the text", () => {
    const { container } = render(<HelpMarkdown text={'1. Click <img src=x onerror="alert(1)"> **Save**'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(screen.getByText("Save", { selector: "strong" })).toBeInTheDocument();
  });
});
