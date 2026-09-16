"use client";

import * as React from "react";
import { ArrowDownLeft, ArrowUpRight, Lightbulb, ShieldAlert, Sparkles, Target } from "lucide-react";
import { FollowUpDialog, type FollowUpContact } from "@/components/crm/deals/follow-up-dialog";
import { RiskBadge } from "@/components/crm/risk-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import type { Deal, DealInsights } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn, formatDateTime, humanize } from "@/lib/utils";

const CONFIDENCE_VARIANT = { high: "success", medium: "warning", low: "neutral" } as const;

function Card({ title, icon, aside, children, className }: { title: string; icon: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-md border border-border bg-surface p-4", className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-fg-subtle [&_svg]:size-4" aria-hidden>
          {icon}
        </span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="ml-auto flex items-center gap-2">{aside}</div>
      </div>
      {children}
    </section>
  );
}

/** Rules-based risk: level, why, and what to do about it. `compact` hides the raw signals. */
export function RiskCard({ risk, compact = false, className }: { risk: DealInsights["risk"]; compact?: boolean; className?: string }) {
  return (
    <Card title="Risk" icon={<ShieldAlert />} aside={<RiskBadge level={risk.level} />} className={className}>
      <p className="mb-2 text-[12px] text-fg-subtle">
        {risk.label || "Rules-based risk"} · score {risk.score}
      </p>
      {risk.reasons.length > 0 ? (
        <ul className="list-disc pl-4 text-sm" aria-label="Risk reasons">
          {risk.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">No risk signals right now.</p>
      )}
      {risk.recommended_action ? (
        <p className="mt-2 rounded-sm bg-bg-subtle px-2.5 py-1.5 text-sm">
          <span className="font-medium">Recommended:</span> {risk.recommended_action}
        </p>
      ) : null}
      {!compact && risk.signals.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Risk signals">
          {risk.signals.map((s, i) => (
            <li key={i} className="rounded-full border border-border px-2 py-px text-[12px] text-fg-muted">
              {humanize(s.signal)}
              {s.days !== undefined ? ` · ${s.days} d` : ""}
              <span className="text-fg-subtle"> +{s.weight}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** The single suggested next step, with the evidence behind it. */
export function NextBestActionCard({ nba, className }: { nba: DealInsights["next_best_action"]; className?: string }) {
  return (
    <Card
      title="Next best action"
      icon={<Target />}
      aside={
        nba ? (
          <>
            {nba.kind ? <span className="text-[12px] text-fg-subtle">{humanize(nba.kind)}</span> : null}
            <Badge variant={CONFIDENCE_VARIANT[nba.confidence] ?? "neutral"}>{nba.confidence} confidence</Badge>
          </>
        ) : null
      }
      className={className}
    >
      {nba ? (
        <>
          <p className="text-sm font-medium">{nba.action}</p>
          {nba.reason ? <p className="mt-1 text-sm text-fg-muted">{nba.reason}</p> : null}
          {nba.evidence.length > 0 ? (
            <ul className="mt-2 list-disc pl-4 text-xs text-fg-muted" aria-label="Evidence">
              {nba.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-fg-muted">No suggestion right now — the deal looks on track. Keep the next activity scheduled.</p>
      )}
      <p className="mt-2 text-[12px] text-fg-subtle">Rules-based suggestion; you decide.</p>
    </Card>
  );
}

/**
 * The AI Insights tab: full risk breakdown, next best action, the primary contact's lead score and
 * communication recency, plus the follow-up generator. Scores need `ai.scores.view`; drafting needs
 * `ai.copilot.use`.
 */
export function DealInsightsPanel({
  deal,
  insights,
  isPending,
  error,
  contact,
}: {
  deal: Deal;
  insights: DealInsights | null | undefined;
  isPending: boolean;
  error?: unknown;
  contact: FollowUpContact | null;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canViewScores = can(active, "ai.scores.view");
  const canUseCopilot = can(active, "ai.copilot.use");
  const [followUpOpen, setFollowUpOpen] = React.useState(false);

  if (!canViewScores && !canUseCopilot) {
    return <EmptyState title="AI insights are not available to you" description="Ask an administrator for access to scores or the AI assistant." className="py-8" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-fg-muted">
          Rules-based insights{insights ? ` · computed ${formatDateTime(insights.computed_at)}` : ""}. No language model is involved unless you ask for a draft.
        </p>
        {canUseCopilot ? (
          <Button size="sm" className="ml-auto" onClick={() => setFollowUpOpen(true)}>
            <Sparkles /> Generate follow-up
          </Button>
        ) : null}
      </div>

      {isPending ? (
        <SkeletonRows rows={3} />
      ) : error ? (
        <EmptyState title="Could not load insights" description={errorMessage(error)} className="py-8" />
      ) : insights ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {canViewScores ? <RiskCard risk={insights.risk} /> : null}
            <NextBestActionCard nba={insights.next_best_action} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {canViewScores ? (
              <Card title="Lead score" icon={<Lightbulb />} aside={insights.lead_score ? <span className="text-sm font-semibold tabular-nums">{insights.lead_score.value}/100</span> : null}>
                {insights.lead_score ? (
                  <>
                    <p className="mb-1 text-[12px] text-fg-subtle">{insights.lead_score.label || "Rules-based"} · primary contact</p>
                    {insights.lead_score.reasons.length > 0 ? (
                      <ul className="list-disc pl-4 text-sm" aria-label="Lead score reasons">
                        {insights.lead_score.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-fg-muted">No scoring factors yet.</p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-fg-muted">{deal.primary_contact ? "No score for the primary contact yet." : "Set a primary contact to see a lead score."}</p>
                )}
              </Card>
            ) : null}
            <Card title="Communication" icon={<ArrowUpRight />}>
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="flex items-center gap-1 text-xs text-fg-subtle">
                    <ArrowUpRight className="size-3" aria-hidden /> Last outbound
                  </dt>
                  <dd className="text-sm">{insights.communication.last_outbound_at ? formatDateTime(insights.communication.last_outbound_at) : "Never"}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1 text-xs text-fg-subtle">
                    <ArrowDownLeft className="size-3" aria-hidden /> Last inbound
                  </dt>
                  <dd className="text-sm">{insights.communication.last_inbound_at ? formatDateTime(insights.communication.last_inbound_at) : "Never"}</dd>
                </div>
              </dl>
            </Card>
          </div>
        </>
      ) : null}

      {canUseCopilot ? <FollowUpDialog open={followUpOpen} onOpenChange={setFollowUpOpen} deal={deal} contact={contact} /> : null}
    </div>
  );
}
