"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, BookOpen, CalendarPlus, Check, Lock, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuickCreate } from "@/components/shell/quick-create-provider";
import { sendHelpFeedback } from "@/lib/api/crm";
import type { AssistantActionProposal, HelpAnswer, HelpContent } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { spotlight } from "@/lib/spotlight";
import { cn } from "@/lib/utils";
import { HelpMarkdown, Inline, MenuPath } from "./markdown";

/**
 * A "how do I..." answer. The steps, menu path and destination all come from the help article on the
 * server; when a model re-phrased them in the user's language, that text was checked against the same
 * article before it got here.
 */
export function HelpAnswerCard({
  help,
  onAsk,
  onNavigate,
}: {
  help: HelpAnswer;
  onAsk?: (question: string) => void;
  /** Called before "Take me there" navigates (the drawer closes so the highlight is visible). */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const article = help.article;

  if (!help.found || !article) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-fg">{help.summary}</p>
        {help.related.length > 0 ? <RelatedChips title="You might be looking for" related={help.related} onAsk={onAsk} /> : null}
      </div>
    );
  }

  const takeMeThere = () => {
    onNavigate?.();
    router.push(article.route);
    if (article.spotlight) spotlight(article.spotlight);
  };

  return (
    <div className="grid gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-sm">
      <div className="grid gap-1.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
          <BookOpen className="size-3.5" aria-hidden />
          {article.module}
          {article.source === "org" ? <span className="rounded-full bg-bg-subtle px-1.5 text-[11px]">Your workspace</span> : null}
        </p>
        <p className="text-sm font-semibold text-fg">{article.title}</p>
        {help.text ? null : <p className="text-sm leading-relaxed text-fg-muted">{help.summary}</p>}
        {article.menu_path ? <MenuPath path={article.menu_path} /> : null}
      </div>

      {!article.permission_ok ? (
        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-fg">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Your role doesn&apos;t include this feature. Contact your workspace admin to get access.
        </p>
      ) : null}

      {help.text ? <HelpMarkdown text={help.text} /> : help.content ? <ArticleBody content={help.content} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={takeMeThere} className="gap-1.5">
          Take me there <ArrowRight className="size-4" aria-hidden />
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/help/${encodeURIComponent(article.id)}`} onClick={onNavigate}>
            Open full guide
          </Link>
        </Button>
      </div>

      {help.related.length > 0 ? <RelatedChips title="Related topics" related={help.related} onAsk={onAsk} /> : null}
    </div>
  );
}

export function ArticleBody({ content }: { content: HelpContent }) {
  return (
    <div className="grid gap-3">
      {content.before_you_start.length > 0 ? (
        <section aria-label="Before you start" className="grid gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Before you start</p>
          <HelpMarkdown text={content.before_you_start.map((line) => `- ${line}`).join("\n")} />
        </section>
      ) : null}
      {content.steps.length > 0 ? (
        <section aria-label="Steps" className="grid gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Steps</p>
          <HelpMarkdown text={content.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")} />
        </section>
      ) : null}
      {content.result ? (
        <section aria-label="Result" className="grid gap-1 rounded-md bg-[#f0fdf4] px-3 py-2">
          <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[#15803d]">
            <Check className="size-3.5" aria-hidden /> Result
          </p>
          <p className="text-sm leading-relaxed text-fg">
            <Inline text={content.result} />
          </p>
        </section>
      ) : null}
      {content.tips.length > 0 ? (
        <section aria-label="Tips" className="grid gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Tips</p>
          <HelpMarkdown text={content.tips.slice(0, 2).map((tip) => `- ${tip}`).join("\n")} className="text-fg-muted" />
        </section>
      ) : null}
    </div>
  );
}

function RelatedChips({ title, related, onAsk }: { title: string; related: HelpAnswer["related"]; onAsk?: (q: string) => void }) {
  return (
    <section aria-label={title} className="grid gap-1.5">
      <p className="text-xs font-medium text-fg-subtle">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {related.slice(0, 3).map((item) =>
          onAsk ? (
            <button
              key={item.id}
              type="button"
              onClick={() => onAsk(item.question)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.title || item.question}
            </button>
          ) : (
            <Link
              key={item.id}
              href={`/help/${encodeURIComponent(item.id)}`}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
            >
              {item.title || item.question}
            </Link>
          ),
        )}
      </div>
    </section>
  );
}

const KIND_LABELS: Record<AssistantActionProposal["kind"], string> = {
  task: "Task",
  call: "Call",
  meeting: "Meeting",
  deal: "Deal",
  contact: "Contact",
  company: "Company",
  ticket: "Ticket",
};

/** "Create a task for tomorrow": open the normal create form pre-filled. Nothing is saved until Save. */
export function ActionProposalCard({ action, onNavigate }: { action: AssistantActionProposal; onNavigate?: () => void }) {
  const quickCreate = useQuickCreate();
  const link = action.links.contact ?? action.links.company ?? action.links.deal;
  const review = () => {
    onNavigate?.();
    quickCreate.open(action.kind, {
      contact: action.links.contact ?? null,
      company: action.links.company ?? null,
      deal: action.links.deal ?? null,
      title: action.title || undefined,
      start_at: action.due_date ? `${action.due_date}T09:00` : undefined,
    });
  };
  return (
    <div className="grid gap-2 rounded-xl border border-border bg-surface p-3.5 shadow-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-fg-subtle">Type</dt>
        <dd className="text-fg">{KIND_LABELS[action.kind]}</dd>
        {action.title ? (
          <>
            <dt className="text-fg-subtle">Title</dt>
            <dd className="text-fg">{action.title}</dd>
          </>
        ) : null}
        {action.due_date ? (
          <>
            <dt className="text-fg-subtle">When</dt>
            <dd className="text-fg">{action.due_date}</dd>
          </>
        ) : null}
        {link ? (
          <>
            <dt className="text-fg-subtle">Linked to</dt>
            <dd className="text-fg">{link.name}</dd>
          </>
        ) : null}
      </dl>
      {action.permission_ok ? (
        <Button size="sm" onClick={review} className="w-fit gap-1.5">
          <CalendarPlus className="size-4" aria-hidden /> Review and create
        </Button>
      ) : null}
    </div>
  );
}

/** 👍 / 👎 on one answer, with an optional comment. One vote per answer; it can be changed. */
export function AnswerFeedback({ turnId }: { turnId: string }) {
  const [rating, setRating] = React.useState<1 | -1 | null>(null);
  const [comment, setComment] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const mutation = useMutation({ mutationFn: sendHelpFeedback });
  const vote = (value: 1 | -1) => {
    setRating(value);
    setSent(false);
    mutation.mutate({ turn_id: turnId, rating: value });
  };
  const sendComment = (event: React.FormEvent) => {
    event.preventDefault();
    if (!rating || !comment.trim()) return;
    mutation.mutate({ turn_id: turnId, rating, comment: comment.trim() }, { onSuccess: () => setSent(true) });
  };
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1 text-xs text-fg-subtle">
        <span>Was this helpful?</span>
        <button
          type="button"
          aria-label="Helpful"
          aria-pressed={rating === 1}
          onClick={() => vote(1)}
          className={cn("rounded-md p-1 hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", rating === 1 && "text-[#15803d]")}
        >
          <ThumbsUp className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Not helpful"
          aria-pressed={rating === -1}
          onClick={() => vote(-1)}
          className={cn("rounded-md p-1 hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", rating === -1 && "text-danger")}
        >
          <ThumbsDown className="size-3.5" />
        </button>
        {mutation.isError ? <span className="text-danger">{errorMessage(mutation.error)}</span> : null}
      </div>
      {rating !== null && !sent ? (
        <form onSubmit={sendComment} className="flex items-center gap-1.5">
          <input
            type="text"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={1000}
            placeholder={rating === 1 ? "Anything to add? (optional)" : "What was missing? (optional)"}
            aria-label="Feedback comment"
            className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="sm" variant="ghost" className="h-7 text-xs" disabled={!comment.trim() || mutation.isPending}>
            Send
          </Button>
        </form>
      ) : null}
      {sent ? <p className="text-xs text-fg-subtle">Thanks for the feedback.</p> : null}
    </div>
  );
}
