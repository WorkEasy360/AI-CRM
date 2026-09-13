"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react";
import { aiErrorMessage } from "@/components/crm/deals/deal-helpers";
import { Button } from "@/components/ui/button";
import { summarizeDeal } from "@/lib/api/crm";
import type { DealSummary } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const SECTIONS: { key: keyof Pick<DealSummary, "value" | "recent_activity" | "customer_concern" | "next_action" | "expected_close">; label: string }[] = [
  { key: "value", label: "Value" },
  { key: "recent_activity", label: "Recent activity" },
  { key: "customer_concern", label: "Customer concern" },
  { key: "next_action", label: "Next action" },
  { key: "expected_close", label: "Expected close" },
];

/**
 * Opt-in AI brief of a deal. Nothing runs until the member clicks; the result is cached per deal
 * and can be refreshed (force). Requires `ai.copilot.use`; renders nothing otherwise.
 */
export function DealSummaryCard({ dealId, className }: { dealId: string; className?: string }) {
  const { data: session } = useSession();
  const canUse = can(session?.active, "ai.copilot.use");
  const queryClient = useQueryClient();
  const key = crmKeys.dealSummary(dealId);
  const cached = useQuery({ queryKey: key, queryFn: () => summarizeDeal(dealId), enabled: false, staleTime: Infinity });
  const generate = useMutation({
    mutationFn: (force: boolean) => summarizeDeal(dealId, force),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });

  if (!canUse) return null;
  const summary = cached.data ?? null;

  return (
    <section className={cn("rounded-md border border-border bg-surface p-4", className)} aria-labelledby={`deal-summary-${dealId}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-primary" aria-hidden />
        <h2 id={`deal-summary-${dealId}`} className="text-sm font-semibold">
          AI summary
        </h2>
        <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-fg-subtle">{summary?.label || "AI-generated draft"}</span>
        {summary?.cached ? <span className="text-[11px] text-fg-subtle">Cached</span> : null}
        <div className="ml-auto flex items-center gap-1">
          {summary ? (
            <Button size="sm" variant="ghost" onClick={() => generate.mutate(true)} loading={generate.isPending}>
              <RefreshCw /> Refresh
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => generate.mutate(false)} loading={generate.isPending}>
              <Sparkles /> Summarize with AI
            </Button>
          )}
        </div>
      </div>

      {generate.isError ? (
        <p role="alert" className="mb-2 text-sm text-danger">
          {aiErrorMessage(generate.error)}
        </p>
      ) : null}

      {summary ? (
        <div className="flex flex-col gap-3">
          {summary.headline ? <p className="text-sm font-medium text-fg">{summary.headline}</p> : null}
          {summary.flagged_input ? (
            <p className="flex items-start gap-2 rounded-sm border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              Some source text was flagged and left out of this summary. Check the timeline for the full picture.
            </p>
          ) : null}
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <div key={s.key} className="min-w-0">
                <dt className="text-xs text-fg-subtle">{s.label}</dt>
                <dd className="whitespace-pre-wrap break-words text-sm">{summary[s.key] || "—"}</dd>
              </div>
            ))}
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-xs text-fg-subtle">Risks</dt>
              <dd className="text-sm">
                {summary.risks.length === 0 ? (
                  "None noted"
                ) : (
                  <ul className="list-disc pl-4">
                    {summary.risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-fg-subtle">
            AI drafts can be wrong — verify before acting.
            {summary.sources.length > 0 ? ` Based on: ${summary.sources.join(", ")}.` : ""}
          </p>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">Get a short brief built from this deal&apos;s notes, activities and messages. Nothing is sent or changed; you decide what to do with it.</p>
      )}
    </section>
  );
}
