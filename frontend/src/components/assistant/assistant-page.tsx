"use client";

import * as React from "react";
import { BarChart3, Bot, FileText, Lightbulb, ListChecks, Megaphone, MessageSquareText, Sparkles, Target, Zap } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { hasPermission, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { AskForm, useAssistant } from "./ask-keel";

interface AssistantAction {
  title: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Icon disc tint; each icon colour is >= 3:1 on its tint. */
  tone: string;
  /** What is sent to the assistant. Plain language; the server decides how to answer it. */
  prompt: string;
}

/** The eight starting points from the WorkEasy360 AI Assistant screen. */
export const ASSISTANT_ACTIONS: readonly AssistantAction[] = [
  {
    title: "Write Message",
    hint: "WhatsApp / Email",
    icon: MessageSquareText,
    tone: "bg-[#dcfce7] text-[#15803d]",
    prompt: "Write a short, friendly WhatsApp follow-up message for my newest lead.",
  },
  {
    title: "Create Follow-up Sequence",
    hint: "Calls, messages, tasks",
    icon: ListChecks,
    tone: "bg-[#fee2e2] text-[#b91c1c]",
    prompt: "Suggest a 3-step follow-up sequence for leads that have not replied in a week.",
  },
  {
    title: "Generate Proposal",
    hint: "Proposal / Quotation",
    icon: FileText,
    tone: "bg-[#dbeafe] text-[#1d4ed8]",
    prompt: "Draft a proposal outline for my largest open deal.",
  },
  {
    title: "Summarize Lead / Deal",
    hint: "History at a glance",
    icon: Bot,
    tone: "bg-[#ede9fe] text-[#6d28d9]",
    prompt: "Summarize my pipeline.",
  },
  {
    title: "Suggest Next Action",
    hint: "AI insights",
    icon: Target,
    tone: "bg-[#fce7f3] text-[#be185d]",
    prompt: "Which deals need attention, and what should I do next on each?",
  },
  {
    title: "Create Campaign",
    hint: "WhatsApp",
    icon: Megaphone,
    tone: "bg-[#dcfce7] text-[#15803d]",
    prompt: "Write a WhatsApp campaign message to re-engage customers who went quiet.",
  },
  {
    title: "Analyze Pipeline",
    hint: "Pipeline & forecast",
    icon: BarChart3,
    tone: "bg-[#ffedd5] text-[#c2410c]",
    prompt: "Analyze my pipeline and forecast for the next three months.",
  },
  {
    title: "Automation Ideas",
    hint: "Save time every week",
    icon: Zap,
    tone: "bg-[#e0f2fe] text-[#0369a1]",
    prompt: "Suggest automations that would save my sales team time.",
  },
];

/** The AI Assistant page: a set of one-click starting points and a free-form question box. */
export function AssistantPage() {
  const { data: session } = useSession();
  const assistant = useAssistant();
  if (!session) return null;
  if (!hasPermission(session.active, "ai.assistant.use") || !assistant) {
    return <EmptyState title="AI Assistant is not part of your role" description="Ask a workspace administrator to give your role access to the assistant." />;
  }
  const { submit, busy, suggestions, knowledgeOnly } = assistant;

  return (
    <div className="mx-auto max-w-5xl py-2">
      <header className="flex flex-col items-center text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-chrome text-white shadow-md" aria-hidden>
          <Bot className="size-7" />
        </span>
        <h1 className="mt-3 flex items-center gap-2 text-2xl font-bold tracking-tight text-fg">
          WorkEasy AI Assistant
          <Sparkles className="size-5 text-[#ca8a04]" aria-hidden />
        </h1>
        <p className="mt-1 text-sm text-fg-muted">Your intelligent CRM copilot for sales, content and growth.</p>
        {knowledgeOnly ? (
          <p className="mt-2 rounded-full border border-border bg-bg-subtle px-2.5 py-0.5 text-xs text-fg-muted">
            Knowledge search mode: answers are assembled from your CRM records.
          </p>
        ) : null}
      </header>

      <ul className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Assistant actions">
        {ASSISTANT_ACTIONS.map((action) => (
          <li key={action.title}>
            <button
              type="button"
              disabled={busy}
              onClick={() => submit(action.prompt)}
              className="flex h-full w-full flex-col items-center gap-2 rounded-lg border border-border bg-surface px-3 py-4 text-center shadow-sm transition-colors hover:border-primary/50 hover:bg-primary-soft/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <span className={cn("flex size-11 items-center justify-center rounded-full", action.tone)} aria-hidden>
                <action.icon className="size-5" />
              </span>
              <span className="text-sm font-semibold text-fg">{action.title}</span>
              <span className="text-xs text-fg-subtle">{action.hint}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-5 rounded-lg border border-border bg-surface p-3 shadow-sm">
        <AskForm onSubmit={submit} busy={busy} placeholder="Ask anything… (e.g. write a follow-up message for a new lead)" />
        {suggestions.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submit(suggestion)}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Lightbulb className="size-3" aria-hidden />
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
