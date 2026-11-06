"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Bot, CircleHelp, Loader2, Mic, MicOff, Search, Sparkles, Trash2 } from "lucide-react";
import { ActionProposalCard, AnswerFeedback, HelpAnswerCard } from "@/components/help/help-answer";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { askKeel, deleteAssistantConversation, getAssistantConversation, getAssistantHome, getHelpArticle, getHelpSuggestions } from "@/lib/api/crm";
import type { AssistantAnswer, AssistantConversation } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
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

export type Turn = { question: string; answer: AssistantAnswer | null; error?: string };

interface AssistantContextValue {
  /** Ask a question; opens the answer panel. */
  submit: (question: string) => void;
  /** Open the answer panel without asking anything. */
  openPanel: () => void;
  closePanel: () => void;
  /** Whether this member may use the assistant at all (the API checks it again on every request). */
  available: boolean;
  busy: boolean;
  suggestions: string[];
  knowledgeOnly: boolean;
  /** The current thread, for the AI Assistant page that shows it inline. */
  turns: Turn[];
  reset: () => Promise<void>;
  /** The AI Assistant page shows the thread itself; while it is mounted, asking does not open the panel. */
  setInline: (inline: boolean) => void;
  recent: { id: string; title: string; last_message_at: string | null }[];
}

const AssistantContext = React.createContext<AssistantContextValue | null>(null);

/** The shared assistant state, so every "Ask" entry point (card, page, floating button) feeds one thread. */
export function useAssistant(): AssistantContextValue | null {
  return React.useContext(AssistantContext);
}

/**
 * Holds the conversation and renders the answer panel once for the whole app. The API checks
 * `ai.assistant.use` on every request; the frontend only uses it to decide what to show.
 */
export function AssistantProvider({ children, force = false }: { children: React.ReactNode; force?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const inlineRef = React.useRef(false);
  const setInline = React.useCallback((inline: boolean) => {
    inlineRef.current = inline;
  }, []);
  const { data: session } = useSession();
  const currency = session?.active?.organization.base_currency ?? "USD";
  // `force` is for a caller that has already decided to show the assistant (the standalone card).
  const allowed = force || hasPermission(session?.active, "ai.assistant.use");
  const queryClient = useQueryClient();
  const pathname = usePathname() || "";
  const threadKey = session?.active ? `workeasy.assistant.thread:${session.active.membership_id}` : "";

  const home = useQuery({ queryKey: crmKeys.assistantHome, queryFn: getAssistantHome, staleTime: 5 * 60_000, enabled: allowed });

  // Chat history persists per member: the thread id is remembered in this browser and the turns are
  // re-read from the server (which only ever returns the caller's own thread).
  const restored = React.useRef(false);
  React.useEffect(() => {
    if (!allowed || !threadKey || restored.current) return;
    restored.current = true;
    const stored = safeStorage()?.getItem(threadKey);
    if (!stored) return;
    let cancelled = false;
    restoreThread(stored)
      .then((restoredTurns) => {
        if (cancelled || !restoredTurns) return;
        setConversationId(stored);
        setTurns((current) => (current.length ? current : restoredTurns));
      })
      .catch(() => safeStorage()?.removeItem(threadKey));
    return () => {
      cancelled = true;
    };
  }, [allowed, threadKey]);
  React.useEffect(() => {
    if (!threadKey) return;
    if (conversationId) safeStorage()?.setItem(threadKey, conversationId);
    else safeStorage()?.removeItem(threadKey);
  }, [conversationId, threadKey]);

  const mutation = useMutation({
    mutationFn: (question: string) => askKeel({ question, conversation_id: conversationId, page: pathname }),
    onSuccess: (answer) => {
      setConversationId(answer.conversation_id);
      setTurns((previous) => replaceLast(previous, { question: answer.question, answer }));
      queryClient.invalidateQueries({ queryKey: crmKeys.assistantHome });
    },
    onError: (error, question) => {
      setTurns((previous) => replaceLast(previous, { question, answer: null, error: errorMessage(error) }));
    },
  });

  const { mutate, isPending } = mutation;
  const submit = React.useCallback(
    (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || isPending) return;
      setTurns((previous) => [...previous, { question: trimmed, answer: null }]);
      if (!inlineRef.current) setOpen(true);
      mutate(trimmed);
    },
    [mutate, isPending],
  );

  const reset = React.useCallback(async () => {
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
  }, [conversationId, queryClient]);

  const suggestions = React.useMemo(() => home.data?.suggestions ?? [], [home.data]);
  const knowledgeOnly = home.data ? !home.data.generative_available : false;
  const openPanel = React.useCallback(() => setOpen(true), []);
  const closePanel = React.useCallback(() => setOpen(false), []);
  const recent = React.useMemo(() => home.data?.recent ?? [], [home.data]);
  const value = React.useMemo(
    () => ({ submit, openPanel, closePanel, available: allowed, busy: isPending, suggestions, knowledgeOnly, turns, reset, setInline, recent }),
    [submit, openPanel, closePanel, allowed, isPending, suggestions, knowledgeOnly, turns, reset, setInline, recent],
  );

  return (
    <AssistantContext.Provider value={value}>
      {children}
      {allowed ? (
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
                Ask WorkEasy AI
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
              {turns.length === 0 ? (
                <PanelWelcome page={pathname} onAsk={submit} suggestions={suggestions} open={open} />
              ) : (
                <Conversation
                  turns={turns}
                  currency={currency}
                  busy={isPending}
                  onAsk={submit}
                  onNavigate={closePanel}
                  userName={session?.user.display_name || session?.user.email}
                />
              )}
            </div>

            <footer className="border-t border-border px-4 py-3">
              <AskForm
                onSubmit={submit}
                busy={isPending}
                voice
                placeholder={turns.length ? "Ask another question…" : "Ask how to do anything, or about your CRM…"}
              />
            </footer>
          </SheetContent>
        </Sheet>
      ) : null}
    </AssistantContext.Provider>
  );
}

/** The dashboard card. Works inside the app-wide provider, or standalone (it then brings its own). */
export function AskKeelCard() {
  const assistant = useAssistant();
  if (!assistant) {
    return (
      <AssistantProvider force>
        <AskKeelCard />
      </AssistantProvider>
    );
  }
  return <AskCardBody assistant={assistant} />;
}

function AskCardBody({ assistant }: { assistant: AssistantContextValue }) {
  const { submit, busy, suggestions, knowledgeOnly } = assistant;
  return (
    <section aria-label="Ask WorkEasy" className="rounded-md border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Sparkles className="size-4 text-primary" aria-hidden />
          Ask WorkEasy
        </h2>
        {knowledgeOnly ? <ModeBadge /> : null}
      </div>
      <p className="mt-0.5 text-xs text-fg-muted">Ask anything about your customers, deals or sales activity.</p>

      <AskForm onSubmit={submit} busy={busy} className="mt-3" />

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
  );
}

/** The floating "Ask WorkEasy AI" pill in the bottom-right corner of every page. */
export function AskFloatingButton() {
  const assistant = useAssistant();
  const { data: session } = useSession();
  if (!assistant || !hasPermission(session?.active, "ai.assistant.use")) return null;
  return (
    <button
      type="button"
      onClick={assistant.openPanel}
      className="fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 inline-flex items-center gap-2 rounded-full bg-chrome py-1.5 pr-3.5 pl-1.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:bottom-5"
    >
      <span className="flex size-7 items-center justify-center rounded-full bg-white/15" aria-hidden>
        <Bot className="size-4" />
      </span>
      Ask WorkEasy AI
      <Sparkles className="size-3.5 text-[#facc15]" aria-hidden />
    </button>
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

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

/** The browser's speech recognition, where it has one (Chrome, Edge, Safari); null elsewhere. */
function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function AskForm({
  onSubmit,
  busy,
  className,
  placeholder = "Ask WorkEasy…",
  voice = false,
  large = false,
}: {
  onSubmit: (question: string) => void;
  busy: boolean;
  className?: string;
  placeholder?: string;
  /** Offer a microphone that types what is said (only where the browser supports it; audio stays in the browser). */
  voice?: boolean;
  large?: boolean;
}) {
  const [value, setValue] = React.useState("");
  const [listening, setListening] = React.useState(false);
  const recognition = React.useRef<SpeechRecognitionLike | null>(null);
  const [canListen, setCanListen] = React.useState(false);
  React.useEffect(() => setCanListen(voice && speechRecognition() !== null), [voice]);
  React.useEffect(() => () => recognition.current?.stop(), []);
  const toggleVoice = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Recognition = speechRecognition();
    if (!Recognition) return;
    const r = new Recognition();
    r.lang = typeof navigator !== "undefined" ? navigator.language : "en-IN";
    r.interimResults = false;
    r.onresult = (event) => {
      const text = Array.from(event.results)
        .map((res) => res[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (text) setValue((v) => (v ? `${v} ${text}` : text).slice(0, 1000));
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recognition.current = r;
    setListening(true);
    r.start();
  };
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
        aria-label="Ask WorkEasy a question"
        maxLength={1000}
        className={cn(
          "min-w-0 flex-1 rounded-sm border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          large ? "h-11 rounded-lg" : "h-9",
        )}
      />
      {canListen ? (
        <Button type="button" variant="ghost" size="icon" onClick={toggleVoice} aria-pressed={listening} aria-label={listening ? "Stop voice input" : "Speak your question"} className={cn(large ? "size-11" : "size-9", listening && "text-danger")}>
          {listening ? <MicOff /> : <Mic />}
        </Button>
      ) : null}
      <Button type="submit" size="sm" className={cn("shrink-0 p-0", large ? "h-11 w-11 rounded-lg" : "h-9 w-9")} disabled={busy || !value.trim()} aria-label="Ask">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
      </Button>
    </form>
  );
}

export function Conversation({
  turns,
  currency,
  busy,
  onAsk,
  onNavigate,
  userName,
}: {
  turns: Turn[];
  currency: string;
  busy: boolean;
  onAsk: (question: string) => void;
  /** Called before an answer navigates away ("Take me there", "Review and create"). */
  onNavigate?: () => void;
  userName?: string;
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
        <article key={index} className="grid gap-3">
          <div className="flex items-start justify-end gap-2">
            <p className="sr-only">You</p>
            <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-[#dcfce7] px-4 py-2.5 text-sm text-fg">{turn.question}</p>
            <Avatar name={userName || "You"} size="sm" className="[&>span]:bg-chrome [&>span]:text-white" />
          </div>
          <div className="flex items-start gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-chrome text-white" aria-hidden>
              <Bot className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="sr-only">WorkEasy</p>
              {turn.answer ? (
                <div className="grid gap-2">
                  <TurnAnswer answer={turn.answer} currency={currency} onAsk={onAsk} onNavigate={onNavigate} />
                  {turn.answer.turn_id ? <AnswerFeedback turnId={turn.answer.turn_id} /> : null}
                </div>
              ) : turn.error ? (
                <p className="text-sm text-danger">{turn.error}</p>
              ) : (
                <p className="flex items-center gap-2 text-sm text-fg-muted">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Looking through your CRM…
                </p>
              )}
            </div>
          </div>
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

/** Help and action answers have their own cards; everything else is the CRM answer view. */
function TurnAnswer({
  answer,
  currency,
  onAsk,
  onNavigate,
}: {
  answer: AssistantAnswer;
  currency: string;
  onAsk: (question: string) => void;
  onNavigate?: () => void;
}) {
  if (answer.help) {
    return (
      <div className="grid gap-2">
        <HelpAnswerCard help={answer.help} onAsk={onAsk} onNavigate={onNavigate} />
        {answer.notice ? <p className="text-xs leading-relaxed text-fg-subtle">{answer.notice}</p> : null}
      </div>
    );
  }
  if (answer.action) {
    return (
      <div className="grid gap-2">
        <p className="text-sm font-medium text-fg">{answer.headline}</p>
        <ActionProposalCard action={answer.action} onNavigate={onNavigate} />
        {answer.analysis ? <p className="text-xs text-fg-subtle">{answer.analysis}</p> : null}
      </div>
    );
  }
  return <AnswerView answer={answer} currency={currency} />;
}

/** The empty panel: questions about the page the member is on, then the usual CRM prompts. */
function PanelWelcome({ page, onAsk, suggestions, open }: { page: string; onAsk: (q: string) => void; suggestions: string[]; open: boolean }) {
  const help = useQuery({
    queryKey: crmKeys.helpSuggestions(page),
    queryFn: () => getHelpSuggestions(page),
    enabled: open && Boolean(page),
    staleTime: 10 * 60_000,
  });
  const pageQuestions = help.data?.suggestions ?? [];
  return (
    <div className="grid gap-4">
      <p className="text-sm text-fg-muted">Ask how to do anything in WorkEasy360, or about your customers, deals and activities.</p>
      {pageQuestions.length > 0 ? (
        <ChipGroup title="Help with this page" icon={<CircleHelp className="size-3.5" aria-hidden />} items={pageQuestions.map((s) => s.question)} onAsk={onAsk} />
      ) : null}
      {suggestions.length > 0 ? (
        <ChipGroup title="About your CRM" icon={<Sparkles className="size-3.5" aria-hidden />} items={suggestions.slice(0, 3)} onAsk={onAsk} />
      ) : null}
    </div>
  );
}

function ChipGroup({ title, icon, items, onAsk }: { title: string; icon: React.ReactNode; items: string[]; onAsk: (q: string) => void }) {
  return (
    <section aria-label={title} className="grid gap-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
        {icon}
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onAsk(item)}
            className="rounded-full border border-border bg-surface px-2.5 py-1 text-left text-xs text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {item}
          </button>
        ))}
      </div>
    </section>
  );
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Rebuild a saved thread. Help answers are re-rendered from their article; other answers as their saved text. */
async function restoreThread(conversationId: string): Promise<Turn[] | null> {
  const thread: AssistantConversation = await getAssistantConversation(conversationId);
  if (!thread.id || thread.turns.length === 0) return null;
  const articles = new Map<string, Awaited<ReturnType<typeof getHelpArticle>> | null>();
  await Promise.all(
    [...new Set(thread.turns.map((t) => t.help_article).filter((slug): slug is string => Boolean(slug)))].map(async (slug) => {
      articles.set(slug, await getHelpArticle(slug).catch(() => null));
    }),
  );
  return thread.turns.map((turn) => {
    const detail = turn.help_article ? articles.get(turn.help_article) : null;
    const answer: AssistantAnswer = {
      conversation_id: thread.id ?? conversationId,
      question: turn.question,
      intent: turn.intent ?? "",
      mode: turn.mode,
      answer_type: detail ? "help" : "answer",
      headline: detail ? detail.summary : turn.answer,
      facts: [],
      analysis: "",
      recommendation: "",
      sections: [],
      sources: [],
      suggestions: [],
      notice: "",
      knowledge_search_only: false,
      turn_id: turn.turn_id,
      help: detail
        ? { found: true, article: detail.article, summary: detail.summary, content: detail.content, text: "", related: detail.related, language: "en", verified: true }
        : undefined,
    };
    return { question: turn.question, answer };
  });
}

function replaceLast(turns: Turn[], turn: Turn): Turn[] {
  const next = [...turns];
  const index = next.findLastIndex((t) => t.answer === null && !t.error);
  if (index >= 0) next[index] = turn;
  else next.push(turn);
  return next;
}
