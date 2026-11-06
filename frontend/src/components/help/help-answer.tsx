"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Info,
  Lightbulb,
  Lock,
  SearchX,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQuickCreate } from "@/components/shell/quick-create-provider";
import { sendHelpFeedback } from "@/lib/api/crm";
import type { AssistantActionProposal, HelpAnswer, HelpContent, HelpRelated } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { spotlight } from "@/lib/spotlight";
import { cn } from "@/lib/utils";
import { HelpMarkdown, Inline, MenuPath } from "./markdown";

/**
 * A "how do I..." answer. The steps, menu path and destination all come from the help article on the
 * server; when a model re-phrased them in the user's language, that text was checked against the same
 * article before it got here.
 *
 * Layout, top to bottom: what this is (module, title, one-line summary, where to find it), what you
 * need first, the steps, what you will see, then the optional extras folded away, and one footer with
 * the actions and the rating. The steps are the answer; everything else is kept quiet around them.
 */
export function HelpAnswerCard({
  help,
  onAsk,
  onNavigate,
  feedback,
  notice,
}: {
  help: HelpAnswer;
  /** A short server note (e.g. "Showing the English guide…"), shown as a strip under the header. */
  notice?: string;
  onAsk?: (question: string) => void;
  /** Called before "Take me there" navigates (the drawer closes so the highlight is visible). */
  onNavigate?: () => void;
  /** Rendered at the right of the card footer (the 👍 / 👎 row). */
  feedback?: React.ReactNode;
}) {
  const router = useRouter();
  const article = help.article;

  if (!help.found || !article) {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        <div className="flex gap-3 px-4 py-3.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-subtle text-fg-muted" aria-hidden>
            <SearchX className="size-4" />
          </span>
          <div className="grid gap-1">
            <p className="text-sm font-semibold text-fg">Not in the help guide yet</p>
            <p className="text-sm leading-relaxed text-fg-muted">{help.summary}</p>
          </div>
        </div>
        {help.related.length > 0 ? <RelatedList title="You might be looking for" related={help.related} onAsk={onAsk} /> : null}
        {feedback ? <div className="flex justify-end border-t border-border px-4 py-2">{feedback}</div> : null}
      </div>
    );
  }

  const takeMeThere = () => {
    onNavigate?.();
    router.push(article.route);
    if (article.spotlight) spotlight(article.spotlight);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <header className="grid gap-2 border-b border-border bg-[linear-gradient(180deg,var(--kl-brand-soft)_0%,transparent_100%)] px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-brand uppercase">
          <BookOpen className="size-3.5" aria-hidden />
          <span>{article.module}</span>
          <span aria-hidden className="text-fg-subtle">
            ·
          </span>
          <span className="text-fg-subtle">Guide</span>
          {article.source === "org" ? (
            <span className="ml-auto rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] tracking-normal text-fg-muted normal-case">
              Your workspace
            </span>
          ) : null}
        </div>
        <h3 className="text-[15px] leading-snug font-semibold text-fg">{article.title}</h3>
        {help.text ? null : <p className="text-sm leading-relaxed text-fg-muted">{help.summary}</p>}
        {article.menu_path ? <MenuPath path={article.menu_path} /> : null}
      </header>
      {notice ? (
        <p className="flex items-start gap-2 border-b border-border bg-bg-subtle/60 px-4 py-2 text-xs leading-relaxed text-fg-muted">
          <Info className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          {notice}
        </p>
      ) : null}

      <div className="grid gap-4 px-4 py-4">
        {!article.permission_ok ? (
          <Callout tone="warning" icon={<Lock />} title="Not available for your role">
            Contact your workspace admin to get access to this feature.
          </Callout>
        ) : null}
        {help.text ? <HelpMarkdown text={help.text} /> : help.content ? <ArticleBody content={help.content} compact /> : null}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-bg-subtle/60 px-4 py-2.5">
        <Button size="sm" onClick={takeMeThere} className="gap-1.5">
          Take me there <ArrowRight className="size-4" aria-hidden />
        </Button>
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-fg-muted">
          <Link href={`/help/${encodeURIComponent(article.id)}`} onClick={onNavigate}>
            Open full guide <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        </Button>
        {feedback ? <div className="ml-auto">{feedback}</div> : null}
      </footer>

      {help.related.length > 0 ? <RelatedList title="Related topics" related={help.related} onAsk={onAsk} /> : null}
    </div>
  );
}

/**
 * The article's own sections. ``compact`` (the chat card) folds tips and troubleshooting away; the Help
 * Center page shows everything open.
 */
export function ArticleBody({ content, compact = false }: { content: HelpContent; compact?: boolean }) {
  return (
    <div className="grid gap-4">
      {content.before_you_start.length > 0 ? (
        <Callout tone="info" icon={<Info />} title="Before you start" label="Before you start">
          <BulletList items={content.before_you_start} />
        </Callout>
      ) : null}

      {content.steps.length > 0 ? (
        <section aria-label="Steps" className="grid gap-2.5">
          <SectionTitle count={content.steps.length} noun="step">
            Steps
          </SectionTitle>
          <Stepper steps={content.steps} />
        </section>
      ) : null}

      {content.result ? (
        <Callout tone="success" icon={<CircleCheck />} title="Result" label="Result">
          <Inline text={content.result} />
        </Callout>
      ) : null}

      {content.tips.length > 0 ? (
        <Extra title="Tips" icon={<Lightbulb />} count={content.tips.length} open={!compact}>
          <BulletList items={content.tips} />
        </Extra>
      ) : null}
      {content.troubleshooting.length > 0 ? (
        <Extra title="Troubleshooting" icon={<Wrench />} count={content.troubleshooting.length} open={!compact}>
          <BulletList items={content.troubleshooting} />
        </Extra>
      ) : null}
    </div>
  );
}

/** Numbered steps on a vertical rail: the eye follows the numbers, the line says "in this order". */
function Stepper({ steps }: { steps: string[] }) {
  return (
    <ol className="grid">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li key={index} className="relative flex gap-3 pb-3 last:pb-0">
            {last ? null : <span aria-hidden className="absolute top-6 bottom-0 left-[11px] w-px bg-border" />}
            <span
              aria-hidden
              className="relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border border-brand/25 bg-brand-soft text-[12px] font-semibold text-brand"
            >
              {index + 1}
            </span>
            <p className="min-w-0 pt-0.5 text-sm leading-relaxed text-fg">
              <span className="sr-only">{`Step ${index + 1}: `}</span>
              <Inline text={step} />
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function SectionTitle({ children, count, noun }: { children: React.ReactNode; count?: number; noun?: string }) {
  return (
    <p className="flex items-baseline gap-2 text-[12px] font-semibold tracking-wide text-fg-subtle uppercase">
      {children}
      {count && noun ? (
        <span className="font-normal tracking-normal normal-case">
          {count} {noun}
          {count === 1 ? "" : "s"}
        </span>
      ) : null}
    </p>
  );
}

const CALLOUT_TONES = {
  info: "border-accent/20 bg-accent-soft [&_[data-icon]]:text-accent",
  success: "border-brand/25 bg-brand-soft [&_[data-icon]]:text-brand",
  warning: "border-warning/40 bg-warning-soft [&_[data-icon]]:text-warning",
} as const;

function Callout({
  tone,
  icon,
  title,
  label,
  children,
}: {
  tone: keyof typeof CALLOUT_TONES;
  icon: React.ReactNode;
  title: string;
  /** Accessible name for the region (tests and screen readers find sections by it). */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label ?? title} className={cn("flex gap-2.5 rounded-lg border px-3 py-2.5", CALLOUT_TONES[tone])}>
      <span data-icon aria-hidden className="mt-0.5 shrink-0 [&_svg]:size-4">
        {icon}
      </span>
      <div className="grid min-w-0 gap-0.5 text-sm leading-relaxed text-fg">
        <p className="font-semibold">{title}</p>
        <div className="text-fg-muted">{children}</div>
      </div>
    </section>
  );
}

/** Optional detail, folded: a native <details> so it is keyboard- and screen-reader-friendly for free. */
function Extra({
  title,
  icon,
  count,
  open,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-fg select-none hover:bg-bg-subtle focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-fg-subtle [&_svg]:size-4">
          {icon}
        </span>
        {title}
        <span className="rounded-full bg-bg-subtle px-1.5 text-[12px] text-fg-muted">{count}</span>
        <ChevronDown className="ml-auto size-4 text-fg-subtle transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="px-3 pt-0.5 pb-2.5">{children}</div>
    </details>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="grid gap-1">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2 text-sm leading-relaxed">
          <span aria-hidden className="mt-[0.6rem] size-1 shrink-0 rounded-full bg-fg-subtle" />
          <span className="min-w-0">
            <Inline text={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function RelatedList({ title, related, onAsk }: { title: string; related: HelpRelated[]; onAsk?: (q: string) => void }) {
  const rowClass =
    "flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg focus-visible:bg-bg-subtle focus-visible:outline-none";
  return (
    <section aria-label={title} className="border-t border-border">
      <p className="px-4 pt-2.5 pb-1 text-[12px] font-semibold tracking-wide text-fg-subtle uppercase">{title}</p>
      <ul className="pb-1.5">
        {related.slice(0, 3).map((item) => (
          <li key={item.id}>
            {onAsk ? (
              <button type="button" onClick={() => onAsk(item.question)} className={rowClass}>
                <BookOpen className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.title || item.question}</span>
                <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              </button>
            ) : (
              <Link href={`/help/${encodeURIComponent(item.id)}`} className={rowClass}>
                <BookOpen className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.title || item.question}</span>
                <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              </Link>
            )}
          </li>
        ))}
      </ul>
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
  const rows: [string, string][] = [
    ["Type", KIND_LABELS[action.kind]],
    ...(action.title ? ([["Title", action.title]] as [string, string][]) : []),
    ...(action.due_date ? ([["When", action.due_date]] as [string, string][]) : []),
    ...(link ? ([["Linked to", link.name]] as [string, string][]) : []),
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <dl className="divide-y divide-border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[6rem_1fr] gap-3 px-4 py-2 text-sm">
            <dt className="text-fg-subtle">{label}</dt>
            <dd className="min-w-0 text-fg">{value}</dd>
          </div>
        ))}
      </dl>
      <footer className="flex items-center gap-2 border-t border-border bg-bg-subtle/60 px-4 py-2.5">
        {action.permission_ok ? (
          <Button size="sm" onClick={review} className="gap-1.5">
            <CalendarPlus className="size-4" aria-hidden /> Review and create
          </Button>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            <CircleAlert className="size-3.5" aria-hidden /> Your role can&apos;t create this. Ask your workspace admin.
          </p>
        )}
      </footer>
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
  const thumb =
    "flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
  return (
    <div className="grid justify-items-end gap-1.5">
      <div className="flex items-center gap-0.5 text-xs text-fg-subtle">
        <span className="mr-1">{sent ? "Thanks for the feedback." : rating ? "Thanks!" : "Helpful?"}</span>
        <button type="button" aria-label="Helpful" aria-pressed={rating === 1} onClick={() => vote(1)} className={cn(thumb, rating === 1 && "bg-brand-soft text-brand")}>
          <ThumbsUp className="size-3.5" />
        </button>
        <button type="button" aria-label="Not helpful" aria-pressed={rating === -1} onClick={() => vote(-1)} className={cn(thumb, rating === -1 && "bg-danger-soft text-danger")}>
          <ThumbsDown className="size-3.5" />
        </button>
      </div>
      {mutation.isError ? <p className="text-xs text-danger">{errorMessage(mutation.error)}</p> : null}
      {rating !== null && !sent ? (
        <form onSubmit={sendComment} className="flex w-full min-w-56 items-center gap-1.5">
          <input
            type="text"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={1000}
            placeholder={rating === 1 ? "Anything to add? (optional)" : "What was missing? (optional)"}
            aria-label="Feedback comment"
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-xs text-fg placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
          <Button type="submit" size="sm" variant="secondary" className="h-7 text-xs" disabled={!comment.trim() || mutation.isPending}>
            Send
          </Button>
        </form>
      ) : null}
    </div>
  );
}
