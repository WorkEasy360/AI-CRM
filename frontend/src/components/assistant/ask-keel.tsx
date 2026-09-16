"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Loader2, Search, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { askKeel, deleteAssistantConversation, getAssistantHome } from "@/lib/api/crm";
import type { AssistantAnswer } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { AnswerView } from "./answer-view";

/**
 * Ask Keel: the one assistant a salesperson sees.
 *
 * There is deliberately no "AI search" / "RAG search" / "chat" distinction in this UI. The question
 * goes to one endpoint, which decides for itself whether to answer from SQL, from retrieved
 * conversations, from a model, or from all three. The only thing the interface ever admits to is
 * whether Keel could write the answer or merely assemble it -- shown as the quiet "Knowledge search
 * mode" badge, never as a provider name or an error code.
 */

type Turn = { question: string; answer: AssistantAnswer | null; error?: string };

export function AskKeelCard() {
  const [open, setOpen] = React.useState(false);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const { data: session } = useSession();
  const currency = session?.active?.organization.base_currency ?? "USD";
  const queryClient = useQueryClient();

  const home = useQuery({ queryKey: crmKeys.assistantHome, queryFn: getAssistantHome, staleTime: 5 * 60_000 });

  const mutation = useMutation({
    mutationFn: (question: string) => askKeel({ question, conversation_id: conversationId }),
    onSuccess: (answer) => {
      setConversationId(answer.conversation_id);
      setTurns((previous) => replaceLast(previous, { question: answer.question, answer }));
      queryClient.invalidateQueries({ queryKey: crmKeys.assistantHome });
    },
    onError: (error, question) => {
      setTurns((previous) => replaceLast(previous, { question, answer: null, error: errorMessage(error) }));
    },
  });

  const submit = React.useCallback(
    (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || mutation.isPending) return;
      setTurns((previous) => [...previous, { question: trimmed, answer: null }]);
      setOpen(true);
      mutation.mutate(trimmed);
    },
    [mutation],
  );

  const reset = async () => {
    if (conversationId) {
      try {
        await deleteAssistantConversation(conversationId);
      } catch {
        // A thread that could not be deleted server-side is still cleared locally; the next
        // question simply starts a new one.
      }
    }
    setTurns([]);
    setConversationId(null);
    queryClient.invalidateQueries({ queryKey: crmKeys.assistantHome });
  };

  const suggestions = home.data?.suggestions ?? [];
  const knowledgeOnly = home.data ? !home.data.generative_available : false;

  return (
    <>
      <section
        aria-label="Ask Keel"
        className="rounded-md border border-border bg-surface px-4 py-3.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Sparkles className="size-4 text-primary" aria-hidden />
            Ask Keel
          </h2>
          {knowledgeOnly ? <ModeBadge /> : null}
        </div>
        <p className="mt-0.5 text-xs text-fg-muted">
          Ask anything about your customers, deals or sales activity.
        </p>

        <AskForm onSubmit={submit} busy={mutation.isPending} className="mt-3" />

        {suggestions.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submit(suggestion)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-[min(34rem,calc(100%-2rem))] gap-0 p-0"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <header className="flex items-center gap-2 border-b border-border px-4 py-3 pr-12">
            <SheetTitle className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles className="size-4 text-primary" aria-hidden />
              Ask Keel
            </SheetTitle>
            {knowledgeOnly ? <ModeBadge /> : null}
            <div className="ml-auto">
              {turns.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={reset} className="h-7 gap-1.5 text-xs">
                  <Trash2 className="size-3.5" aria-hidden />
                  New question
                </Button>
              ) : null}
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <Conversation turns={turns} currency={currency} busy={mutation.isPending} onAsk={submit} />
          </div>

          <footer className="border-t border-border px-4 py-3">
            <AskForm onSubmit={submit} busy={mutation.isPending} placeholder="Ask another question…" />
          </footer>
        </SheetContent>
      </Sheet>
    </>
  );
}

function ModeBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-subtle px-2 py-0.5 text-xs text-fg-muted"
      title="Answers are assembled from your CRM records and conversations."
    >
      <Search className="size-3" aria-hidden />
      Knowledge search mode
    </span>
  );
}

function AskForm({
  onSubmit,
  busy,
  className,
  placeholder = "Ask Keel…",
}: {
  onSubmit: (question: string) => void;
  busy: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [value, setValue] = React.useState("");
  return (
    <form
      className={cn("flex items-center gap-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
        setValue("");
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label="Ask Keel a question"
        maxLength={1000}
        className="h-9 min-w-0 flex-1 rounded-sm border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button type="submit" size="sm" className="h-9 w-9 shrink-0 p-0" disabled={busy || !value.trim()} aria-label="Ask">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
      </Button>
    </form>
  );
}

function Conversation({
  turns,
  currency,
  busy,
  onAsk,
}: {
  turns: Turn[];
  currency: string;
  busy: boolean;
  onAsk: (question: string) => void;
}) {
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    // Optional call: not every rendering environment implements scrollIntoView (jsdom, some embeds).
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, busy]);

  const followUps = turns.at(-1)?.answer?.suggestions ?? [];

  return (
    <div className="grid gap-5">
      {turns.map((turn, index) => (
        <article key={index} className="grid gap-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">You</p>
          <p className="text-sm text-fg">{turn.question}</p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-fg-subtle">Keel</p>
          {turn.answer ? (
            <AnswerView answer={turn.answer} currency={currency} />
          ) : turn.error ? (
            <p className="text-sm text-danger">{turn.error}</p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Looking through your CRM…
            </p>
          )}
        </article>
      ))}

      {!busy && followUps.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {followUps.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onAsk(suggestion)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}

function replaceLast(turns: Turn[], turn: Turn): Turn[] {
  const next = [...turns];
  const index = next.findLastIndex((t) => t.answer === null && !t.error);
  if (index >= 0) next[index] = turn;
  else next.push(turn);
  return next;
}
