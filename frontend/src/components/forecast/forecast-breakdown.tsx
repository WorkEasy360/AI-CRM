import * as React from "react";
import Link from "next/link";
import { EmptyNote } from "@/components/dashboard/stat-tile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Forecast, ForecastGroupBy } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";

export const GROUP_LABELS: Record<ForecastGroupBy, string> = { stage: "Stage", owner: "Salesperson", team: "Team", pipeline: "Pipeline" };

/** Where a breakdown row leads: the pipeline list filtered to that stage, owner or pipeline. */
export function rowHref(groupBy: ForecastGroupBy, id: string, pipeline?: string): string | null {
  const scope = pipeline ? `&pipeline=${encodeURIComponent(pipeline)}` : "";
  switch (groupBy) {
    case "stage":
      return `/pipeline?view=list&stage=${encodeURIComponent(id)}${scope}`;
    case "owner":
      return `/pipeline?view=list&owner=${encodeURIComponent(id)}${scope}`;
    case "pipeline":
      return `/pipeline?view=list&pipeline=${encodeURIComponent(id)}`;
    default:
      return null;
  }
}

export function ForecastBreakdown({ forecast, currency, pipeline }: { forecast: Forecast; currency: string; pipeline?: string }) {
  const { breakdown, totals, group_by: groupBy } = forecast;
  if (breakdown.length === 0) return <EmptyNote>No deals closing in this period.</EmptyNote>;
  const money = (v: string) => <span className="tabular-nums">{formatMoney(v, currency)}</span>;
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead>{GROUP_LABELS[groupBy]}</TableHead>
          <TableHead className="text-right">Deals</TableHead>
          <TableHead className="text-right">Pipeline</TableHead>
          <TableHead className="text-right">Weighted</TableHead>
          <TableHead className="text-right">Committed</TableHead>
          <TableHead className="text-right">Won</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {breakdown.map((row) => {
          const href = rowHref(groupBy, row.id, pipeline);
          return (
            <TableRow key={row.id}>
              <TableCell>
                {href ? (
                  <Link prefetch={false} href={href} className="font-medium text-fg hover:text-primary hover:underline">
                    {row.label}
                  </Link>
                ) : (
                  <span className="font-medium text-fg">{row.label}</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.count}</TableCell>
              <TableCell className="text-right">{money(row.amount)}</TableCell>
              <TableCell className="text-right font-medium text-fg">{money(row.weighted)}</TableCell>
              <TableCell className="text-right">{money(row.committed)}</TableCell>
              <TableCell className="text-right">
                {money(row.won_amount)}
                {row.won_count > 0 ? <span className="ml-1 text-fg-subtle">({row.won_count})</span> : null}
              </TableCell>
            </TableRow>
          );
        })}
        <TableRow className="border-t-2 border-border font-semibold text-fg">
          <TableCell>Total</TableCell>
          <TableCell className="text-right tabular-nums">{totals.pipeline.count}</TableCell>
          <TableCell className="text-right">{money(totals.pipeline.amount)}</TableCell>
          <TableCell className="text-right">{money(totals.weighted.amount)}</TableCell>
          <TableCell className="text-right">{money(totals.committed.amount)}</TableCell>
          <TableCell className="text-right">
            {money(totals.won.amount)}
            {totals.won.count > 0 ? <span className="ml-1 font-normal text-fg-subtle">({totals.won.count})</span> : null}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
