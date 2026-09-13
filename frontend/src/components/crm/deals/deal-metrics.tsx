"use client";

import { Check } from "lucide-react";
import type { StageTarget } from "@/components/crm/deals/move-stage-dialog";
import { daysUntil, isPastClose, relativeDayLabel } from "@/components/crm/deals/deal-helpers";
import { StageBadge } from "@/components/crm/pipeline/deals-list";
import { RiskBadge } from "@/components/crm/risk-badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Deal, DealInsights, PipelineStage } from "@/lib/api/crm-types";
import { formatMoney, stageDotClass } from "@/lib/crm/format";
import { cn, formatDate } from "@/lib/utils";

/* ------------------------------------------------------------------ stage progress */

/**
 * The deal's position in its pipeline. The default variant renders named pills; `compact` renders
 * a segmented bar that fits inside a metric tile. Either way each non-current stage is a button
 * ("Move to X") when the member may change stages.
 */
export function StageProgress({
  stages,
  current,
  status,
  canMove,
  busy,
  onSelect,
  compact = false,
}: {
  stages: PipelineStage[];
  current: Deal["stage"];
  status: Deal["status"];
  canMove: boolean;
  busy: boolean;
  onSelect: (stage: StageTarget) => void;
  compact?: boolean;
}) {
  if (stages.length === 0) {
    return compact ? null : <StageBadge name={current.name} colorToken={current.color_token} />;
  }
  const currentIndex = stages.findIndex((s) => s.id === current.id);

  if (compact) {
    return (
      <ol className="flex items-center gap-0.5" aria-label="Stage progress">
        {stages.map((stage, index) => {
          const isCurrent = stage.id === current.id;
          const reached = currentIndex >= 0 && index < currentIndex;
          const bar = cn(
            "block h-1.5 w-full rounded-full transition-colors",
            isCurrent ? (status === "won" ? "bg-success" : status === "lost" ? "bg-danger" : "bg-primary") : reached ? "bg-primary/45" : "bg-border-strong",
            canMove && !isCurrent && "hover:bg-primary/70",
          );
          return (
            <li key={stage.id} className="min-w-0 flex-1">
              {canMove && !isCurrent ? (
                <button type="button" className={cn(bar, "cursor-pointer")} onClick={() => onSelect(stage)} disabled={busy} aria-label={`Move to ${stage.name}`} title={stage.name} />
              ) : (
                <span className={bar} aria-current={isCurrent ? "step" : undefined} title={stage.name} />
              )}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <ol className="mt-1 flex flex-wrap items-center gap-1" aria-label="Stage progress">
      {stages.map((stage, index) => {
        const isCurrent = stage.id === current.id;
        const reached = status === "open" ? currentIndex >= 0 && index < currentIndex : false;
        const classes = cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
          isCurrent ? "border-primary bg-primary text-primary-fg" : reached ? "border-primary/40 bg-primary-soft text-primary" : "border-border bg-surface text-fg-muted",
          canMove && !isCurrent && "hover:border-primary hover:text-primary",
        );
        const inner = (
          <>
            <span className={cn("size-2 rounded-full", isCurrent ? "bg-primary-fg" : stageDotClass(stage.color_token))} aria-hidden />
            {stage.name}
            {isCurrent ? <Check className="size-3" aria-hidden /> : null}
          </>
        );
        return (
          <li key={stage.id} className="flex items-center">
            {canMove && !isCurrent ? (
              <button type="button" className={classes} onClick={() => onSelect(stage)} disabled={busy} aria-label={`Move to ${stage.name}`}>
                {inner}
              </button>
            ) : (
              <span className={classes} aria-current={isCurrent ? "step" : undefined}>
                {inner}
              </span>
            )}
            {index < stages.length - 1 ? <span className="mx-0.5 h-px w-2 bg-border-strong" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ metric tiles */

function Tile({ label, children, sub, tone, className }: { label: string; children: React.ReactNode; sub?: React.ReactNode; tone?: "danger"; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-surface px-3 py-2", tone === "danger" && "border-danger/40 bg-danger-soft/40", className)}>
      <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className={cn("min-w-0 text-sm font-semibold leading-tight text-fg", tone === "danger" && "text-danger")}>{children}</dd>
      {sub ? <div className="min-w-0 truncate text-xs text-fg-muted">{sub}</div> : null}
    </div>
  );
}

/**
 * The six numbers a salesperson needs at a glance: value, stage, probability, expected close, the
 * primary contact's rules-based score and the deal's risk. Scores and risk respect `ai.scores.view`.
 */
export function DealMetrics({
  deal,
  baseCurrency,
  stages,
  insights,
  insightsPending,
  canViewScores,
  canMove,
  busy,
  onSelectStage,
}: {
  deal: Deal;
  baseCurrency: string;
  stages: PipelineStage[];
  insights: DealInsights | null | undefined;
  insightsPending: boolean;
  canViewScores: boolean;
  canMove: boolean;
  busy: boolean;
  onSelectStage: (stage: StageTarget) => void;
}) {
  const open = deal.status === "open";
  const foreign = deal.currency !== baseCurrency;
  const stageDefault = stages.find((s) => s.id === deal.stage.id)?.default_probability;
  const daysInStage = Math.abs(daysUntil(deal.stage_entered_at) ?? 0);
  const overdue = isPastClose(deal);
  const closeDiff = daysUntil(deal.expected_close_date);
  const risk = insights?.risk;
  const riskLevel = risk?.level ?? deal.risk_level;
  const score = insights?.lead_score ?? null;
  const pendingScores = canViewScores && insightsPending;

  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" aria-label="Deal metrics">
      <Tile
        label="Value"
        sub={
          <>
            {foreign ? <span>≈ {formatMoney(deal.amount_base, baseCurrency)} · </span> : null}
            <span>Weighted: {formatMoney(deal.weighted_amount_base, baseCurrency)}</span>
          </>
        }
      >
        <span className="tabular-nums">{formatMoney(deal.amount, deal.currency)}</span>
      </Tile>

      <Tile label="Stage" sub={stages.length > 0 ? <StageProgress compact stages={stages} current={deal.stage} status={deal.status} canMove={canMove} busy={busy} onSelect={onSelectStage} /> : undefined}>
        <span className="flex items-center gap-1.5">
          <StageBadge name={deal.stage.name} colorToken={deal.stage.color_token} />
          <span className="truncate text-xs font-normal text-fg-muted">{daysInStage === 0 ? "today" : `${daysInStage} d`}</span>
        </span>
      </Tile>

      <Tile label="Probability" sub={stageDefault !== undefined ? `Stage default ${stageDefault}%` : "Stage default"}>
        <span className="tabular-nums">{deal.probability}%</span>
        {deal.probability_overridden ? (
          <span className="ml-1.5 rounded-sm border border-border-strong px-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted" title="Set by hand; the stage default no longer applies.">
            manual
          </span>
        ) : null}
      </Tile>

      {open ? (
        <Tile label="Expected close" tone={overdue ? "danger" : undefined} sub={deal.expected_close_date ? formatDate(deal.expected_close_date) : "Set a date to forecast this deal"}>
          {closeDiff === null ? "Not set" : overdue ? `${Math.abs(closeDiff)} ${Math.abs(closeDiff) === 1 ? "day" : "days"} overdue` : relativeDayLabel(deal.expected_close_date)}
        </Tile>
      ) : (
        <Tile label={deal.status === "won" ? "Won on" : "Lost on"} sub={deal.expected_close_date ? `Expected ${formatDate(deal.expected_close_date)}` : undefined}>
          {formatDate(deal.closed_at)}
        </Tile>
      )}

      <Tile label="AI score" sub={!canViewScores ? "Not available to you" : pendingScores ? undefined : score ? `Rules-based · ${score.label}` : deal.primary_contact ? "Rules-based" : "No primary contact"}>
        {!canViewScores ? "—" : pendingScores ? <Skeleton className="h-4 w-12" /> : score ? <span className="tabular-nums">{score.value}</span> : "—"}
      </Tile>

      <Tile label="Risk" sub={!canViewScores ? "Not available to you" : !open ? "Closed deal" : risk?.reasons[0] ? risk.reasons[0] : pendingScores ? undefined : "Rules-based"}>
        {!canViewScores || !open ? "—" : pendingScores && !risk ? <Skeleton className="h-4 w-16" /> : <RiskBadge level={riskLevel} reason={risk?.reasons[0]} />}
      </Tile>
    </dl>
  );
}
