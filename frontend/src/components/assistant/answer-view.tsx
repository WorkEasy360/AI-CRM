"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, CircleCheck, Lightbulb, Sparkles } from "lucide-react";
import type { AssistantAnswer, AssistantItem, AssistantSection, AssistantSource } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { cn, formatDate } from "@/lib/utils";

/**
 * One answer, rendered so a salesperson can tell three different things apart at a glance:
 *
 *   FACTS           what the CRM says      - computed by the server, never by the model
 *   ANALYSIS        what Keel makes of it  - only present when a model wrote the answer
 *   RECOMMENDATION  what to do next        - advice, never phrased as something that happened
 *
 * Keeping them visually distinct is the point. An assistant that blends a real figure, a guess and a
 * suggestion into one paragraph teaches people to trust all three equally, which is the wrong lesson.
 */
export function AnswerView({ answer, currency }: { answer: AssistantAnswer; currency: string }) {
  return (
    <div className="grid gap-4">
      {answer.headline ? <p className="text-sm font-medium leading-relaxed text-fg">{answer.headline}</p> : null}

      {answer.facts.length > 0 ? (
        <section aria-label="From your CRM" className="grid gap-1.5">
          <SectionLabel icon={<CircleCheck />} tone="fact">
            From your CRM
          </SectionLabel>
          <ul className="grid gap-1 text-sm text-fg-muted">
            {answer.facts.map((fact, index) => (
              <li key={index} className="flex gap-2">
                <span aria-hidden className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-fg-subtle" />
                <span>{fact}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {answer.analysis ? (
        <section aria-label="Keel's analysis" className="grid gap-1.5">
          <SectionLabel icon={<Sparkles />} tone="analysis">
            Analysis
          </SectionLabel>
          <p className="text-sm leading-relaxed text-fg-muted">{answer.analysis}</p>
        </section>
      ) : null}

      {answer.recommendation ? (
        <section aria-label="Recommended next step" className="rounded-md border border-border bg-bg-subtle px-3 py-2.5">
          <SectionLabel icon={<Lightbulb />} tone="recommendation">
            Suggested next step
          </SectionLabel>
          <p className="mt-1 text-sm leading-relaxed text-fg">{answer.recommendation}</p>
        </section>
      ) : null}

      {answer.sections.map((section, index) => (
        <AnswerSection key={`${section.title}-${index}`} section={section} currency={currency} />
      ))}

      {answer.sources.length > 0 ? <Sources sources={answer.sources} /> : null}

      {answer.notice ? (
        <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs leading-relaxed text-fg-muted">
          {answer.notice}
        </p>
      ) : null}
    </div>
  );
}

const TONE_CLASSES = {
  fact: "text-fg-subtle",
  analysis: "text-primary",
  recommendation: "text-fg-subtle",
} as const;

function SectionLabel({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone: keyof typeof TONE_CLASSES;
  children: React.ReactNode;
}) {
  return (
    <p className={cn("flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide", TONE_CLASSES[tone])}>
      <span className="[&_svg]:size-3.5" aria-hidden>
        {icon}
      </span>
      {children}
    </p>
  );
}

function AnswerSection({ section, currency }: { section: AssistantSection; currency: string }) {
  if (section.items.length === 0) return null;
  return (
    <section aria-label={section.title} className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{section.title}</p>
        {section.hint ? <p className="text-xs text-fg-subtle">{section.hint}</p> : null}
      </div>
      {section.kind === "metrics" ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {section.items.map((item, index) => (
            <Metric key={`${item.label}-${index}`} item={item} currency={currency} />
          ))}
        </div>
      ) : (
        <ul className="grid gap-1">
          {section.items.map((item, index) => (
            <li key={item.id ?? index}>
              <RowItem item={item} currency={currency} kind={section.kind} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Metric({ item, currency }: { item: AssistantItem; currency: string }) {
  const hasAmount = item.amount !== undefined && item.amount !== null;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <p className="truncate text-xs text-fg-muted">{item.label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-fg">
        {hasAmount ? formatMoney(item.amount, item.currency ?? currency) : (item.count ?? 0).toLocaleString()}
      </p>
      {hasAmount && item.count !== undefined && item.count !== null ? (
        <p className="truncate text-xs text-fg-subtle">{item.count.toLocaleString()} deals</p>
      ) : item.hint ? (
        <p className="truncate text-xs text-fg-subtle">{item.hint}</p>
      ) : null}
    </div>
  );
}

function RowItem({ item, currency, kind }: { item: AssistantItem; currency: string; kind: string }) {
  const body = (
    <div className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {item.label ? <span className="text-xs font-medium text-fg-subtle">{item.label}</span> : null}
          <span className="truncate text-sm font-medium text-fg">{item.title}</span>
          {item.occurred_at ? <span className="text-xs text-fg-subtle">{formatDate(item.occurred_at)}</span> : null}
        </div>
        {item.snippet ? <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-fg-muted">{item.snippet}</p> : null}
        {item.subtitle || item.meta ? (
          <p className="mt-0.5 truncate text-xs text-fg-subtle">
            {[item.subtitle, item.meta].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </div>
      {item.amount !== undefined && item.amount !== null && kind === "records" ? (
        <span className="shrink-0 text-sm font-semibold tabular-nums text-fg">
          {formatMoney(item.amount, item.currency ?? currency)}
        </span>
      ) : null}
    </div>
  );
  // A row is only a link when the caller may actually open the record; the server omits the href
  // for anything outside their scope rather than returning a link that 404s.
  return item.href ? (
    <Link href={item.href} className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Evidence. Every entry was resolved inside the caller's permission scope before it got here. */
function Sources({ sources }: { sources: AssistantSource[] }) {
  return (
    <section aria-label="Sources" className="grid gap-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Sources</p>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((source) => {
          const label = (
            <>
              <span className="text-fg-subtle">{source.subtitle}</span>
              <span className="truncate">{source.title}</span>
              {source.occurred_at ? <span className="text-fg-subtle">{formatDate(source.occurred_at)}</span> : null}
            </>
          );
          const className =
            "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-fg";
          return (
            <li key={`${source.type}:${source.id}`} className="max-w-full">
              {source.href ? (
                <Link href={source.href} className={cn(className, "hover:bg-bg-subtle")}>
                  {label}
                  <ArrowUpRight className="size-3 shrink-0 text-fg-subtle" aria-hidden />
                </Link>
              ) : (
                <span className={className}>{label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
