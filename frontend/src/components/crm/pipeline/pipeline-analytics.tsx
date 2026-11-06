"use client";

import { useQuery } from "@tanstack/react-query";
import { Panel, EmptyNote } from "@/components/dashboard/stat-tile";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import type { ListParams } from "@/lib/api/crm-types";
import { getPipelineAnalytics, pipelineKeys } from "@/lib/api/pipeline-analytics";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney, stageDotClass } from "@/lib/crm/format";
import { cn } from "@/lib/utils";

/** A thin bar with its value as text beside it, so the number never depends on reading the bar. */
function Bar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="block h-2 w-full rounded-full bg-bg-subtle" aria-hidden>
      <span className={cn("block h-2 rounded-full", className ?? "bg-brand")} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** The Pipeline page's Analytics tab: conversion by stage, win/loss, sources and owner performance. */
export function PipelineAnalyticsView({ pipelineId, filters, baseCurrency }: { pipelineId: string | undefined; filters: ListParams; baseCurrency: string }) {
  const query = useQuery({ queryKey: pipelineKeys.analytics(pipelineId, filters), queryFn: () => getPipelineAnalytics(pipelineId, filters), placeholderData: (prev) => prev });
  if (query.isPending) return <SkeletonRows rows={8} />;
  if (query.isError) return <EmptyState title="Could not load analytics" description={errorMessage(query.error)} action={<Button variant="secondary" onClick={() => query.refetch()}>Retry</Button>} />;
  const data = query.data;
  if (!data.pipeline) return <EmptyNote>No pipeline to analyse yet.</EmptyNote>;
  const maxReached = Math.max(0, ...data.conversion.map((s) => s.reached));
  const maxSource = Math.max(0, ...data.sources.map((s) => s.count));
  const maxOwner = Math.max(0, ...data.owners.map((o) => o.deals));
  const wl = data.win_loss;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Conversion by stage" subtitle="Deals that reached each stage, as a share of those that entered the first">
        {data.conversion.length === 0 ? (
          <EmptyNote>This pipeline has no stages.</EmptyNote>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {data.conversion.map((stage) => (
              <li key={stage.id} className="grid grid-cols-[8rem_minmax(0,1fr)_5.5rem] items-center gap-3 text-sm">
                <span className="truncate font-medium text-fg" title={stage.name}>{stage.name}</span>
                <Bar value={stage.reached} max={maxReached} className={stageDotClass(stage.color_token)} />
                <span className="text-right tabular-nums text-fg-muted">
                  {stage.reached.toLocaleString()} {stage.rate !== null ? <span className="text-fg">· {stage.rate}%</span> : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Win / loss" subtitle="Every closed deal in this pipeline">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-[#dcfce7] px-2 py-3">
            <p className="text-xs font-medium text-[#15803d]">Won</p>
            <p className="text-2xl font-bold tabular-nums text-fg">{wl.won.toLocaleString()}</p>
            {wl.won_amount !== null ? <p className="text-xs tabular-nums text-fg-muted">{formatMoney(wl.won_amount, baseCurrency)}</p> : null}
          </div>
          <div className="rounded-lg bg-[#fee2e2] px-2 py-3">
            <p className="text-xs font-medium text-[#b91c1c]">Lost</p>
            <p className="text-2xl font-bold tabular-nums text-fg">{wl.lost.toLocaleString()}</p>
            {wl.lost_amount !== null ? <p className="text-xs tabular-nums text-fg-muted">{formatMoney(wl.lost_amount, baseCurrency)}</p> : null}
          </div>
          <div className="rounded-lg bg-[#f3e8ff] px-2 py-3">
            <p className="text-xs font-medium text-[#7e22ce]">Win rate</p>
            <p className="text-2xl font-bold tabular-nums text-fg">{wl.win_rate === null ? "—" : `${wl.win_rate}%`}</p>
            <p className="text-xs tabular-nums text-fg-muted">{wl.open.toLocaleString()} still open</p>
          </div>
        </div>
        {wl.lost_reasons.length ? (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold text-fg-muted">Top lost reasons</p>
            <ul className="flex flex-col gap-1 text-sm">
              {wl.lost_reasons.map((r) => (
                <li key={r.reason} className="flex justify-between gap-2">
                  <span className="truncate text-fg">{r.reason}</span>
                  <span className="tabular-nums text-fg-muted">{r.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      <Panel title="Deals by source" subtitle="Where deals came from, and how many were won">
        {data.sources.length === 0 ? (
          <EmptyNote>No deals yet.</EmptyNote>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="pb-1.5 font-medium">Source</th>
                <th className="w-1/3 pb-1.5 font-medium"><span className="sr-only">Share</span></th>
                <th className="pb-1.5 text-right font-medium">Deals</th>
                <th className="pb-1.5 text-right font-medium">Won</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.source || "none"} className="border-t border-border">
                  <td className="py-1.5 text-fg">{s.label}</td>
                  <td className="px-2 py-1.5"><Bar value={s.count} max={maxSource} /></td>
                  <td className="py-1.5 text-right tabular-nums">{s.count.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums text-fg-muted">{s.won.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Owner performance" subtitle="Deals, wins and revenue won per owner">
        {data.owners.length === 0 ? (
          <EmptyNote>No owners to compare.</EmptyNote>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="pb-1.5 font-medium">Owner</th>
                <th className="pb-1.5 font-medium">Deals</th>
                <th className="pb-1.5 text-right font-medium">Win rate</th>
                <th className="pb-1.5 text-right font-medium">Won</th>
              </tr>
            </thead>
            <tbody>
              {data.owners.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="py-1.5 pr-2 text-fg">{o.name}</td>
                  <td className="py-1.5 pr-2">
                    <span className="flex items-center gap-2">
                      <span className="w-6 tabular-nums">{o.deals}</span>
                      <Bar value={o.deals} max={maxOwner} />
                    </span>
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-fg-muted">{o.win_rate === null ? "—" : `${o.win_rate}%`}</td>
                  <td className="py-1.5 text-right tabular-nums">{o.won_amount !== null ? formatMoney(o.won_amount, baseCurrency) : o.won.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
