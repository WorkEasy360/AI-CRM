"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getRecordChart } from "@/lib/api/crm";
import type { EntityType, ListParams } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney, formatNumber } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { useModuleSchema } from "@/lib/views";

const NUMERIC = new Set(["integer", "number", "money", "percent"]);

/**
 * One grouped measure per view: how many records, or the sum of a number field, per value of a
 * groupable field. A single series (one hue, no legend) as horizontal bars with a table view.
 * Full dashboards are Milestone 7.
 */
export function RecordChart({
  entity,
  filters,
  groupBy,
  measure,
  field,
  baseCurrency,
  onChange,
}: {
  entity: EntityType;
  filters: ListParams;
  groupBy: string | undefined;
  measure: "count" | "sum";
  field: string | undefined;
  baseCurrency: string;
  onChange: (patch: { group?: string; measure?: string; mfield?: string }) => void;
}) {
  const schema = useModuleSchema(entity);
  const groupable = (schema.data?.fields ?? []).filter((f) => f.groupable);
  const numeric = (schema.data?.fields ?? []).filter((f) => NUMERIC.has(f.type) && !f.custom);
  const group = groupable.find((f) => f.key === groupBy) ?? groupable[0];
  const summed = measure === "sum" ? (numeric.find((f) => f.key === field) ?? numeric[0]) : undefined;
  const [asTable, setAsTable] = React.useState(false);
  const params = React.useMemo(
    () => ({ ...filters, group_by: group?.key ?? "", measure: summed ? ("sum" as const) : ("count" as const), field: summed?.key }),
    [filters, group, summed],
  );
  const chart = useQuery({
    queryKey: crmKeys.chart(entity, params),
    queryFn: () => getRecordChart(entity, params),
    enabled: Boolean(group),
    placeholderData: (prev) => prev,
  });

  if (schema.isPending) return <Skeleton className="h-64 w-full" />;
  if (!group) return <EmptyState title="Nothing to chart" description="This module has no field that can group records." />;
  const series = chart.data?.series ?? [];
  const values = series.map((p) => Number(p.value) || 0);
  const max = Math.max(1, ...values);
  const format = (v: number) => (summed?.type === "money" ? formatMoney(v, baseCurrency) : formatNumber(v));
  const measureLabel = summed ? `Total ${summed.label.toLowerCase()}` : "Records";
  const title = `${measureLabel} by ${group.label.toLowerCase()}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <Select value={summed ? "sum" : "count"} onValueChange={(v) => onChange({ measure: v, mfield: v === "sum" ? (summed?.key ?? numeric[0]?.key) : undefined })}>
          <SelectTrigger className="h-8 w-36" aria-label="Measure">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="count">Count records</SelectItem>
            {numeric.length ? <SelectItem value="sum">Sum of a field</SelectItem> : null}
          </SelectContent>
        </Select>
        {summed ? (
          <Select value={summed.key} onValueChange={(v) => onChange({ measure: "sum", mfield: v })}>
            <SelectTrigger className="h-8 w-44" aria-label="Field to add up">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {numeric.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <span>by</span>
        <Select value={group.key} onValueChange={(v) => onChange({ group: v })}>
          <SelectTrigger className="h-8 w-44" aria-label="Group by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groupable.map((f) => (
              <SelectItem key={f.key} value={f.key}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>
          {asTable ? "Show chart" : "Show table"}
        </Button>
      </div>

      <figure className="rounded-md border border-border bg-surface p-4">
        <figcaption className="mb-3 text-sm font-semibold text-fg">{title}</figcaption>
        {chart.isError ? (
          <p className="text-sm text-danger">{errorMessage(chart.error)}</p>
        ) : !chart.data ? (
          <Skeleton className="h-48 w-full" />
        ) : series.length === 0 ? (
          <p className="py-8 text-center text-sm text-fg-subtle">No records match.</p>
        ) : asTable ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-fg-muted">
                <th className="py-1.5 font-medium">{group.label}</th>
                <th className="py-1.5 text-right font-medium">{measureLabel}</th>
              </tr>
            </thead>
            <tbody>
              {series.map((p, i) => (
                <tr key={String(p.key)} className="border-b border-border last:border-0">
                  <td className="py-1.5 text-fg">{p.label}</td>
                  <td className="py-1.5 text-right tabular-nums text-fg">{format(values[i]!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ol className="flex flex-col gap-2" aria-label={title}>
            {series.map((p, i) => {
              const value = values[i]!;
              return (
                <li key={String(p.key)} className="group grid grid-cols-[minmax(6rem,12rem)_1fr_auto] items-center gap-3 text-xs" title={`${p.label}: ${format(value)}`}>
                  <span className="truncate font-medium text-fg">{p.label}</span>
                  <span className="h-3 rounded-sm bg-bg-subtle">
                    <span className="block h-full rounded-r-[4px] bg-primary transition-opacity group-hover:opacity-80" style={{ width: `${Math.max(0.5, (value / max) * 100)}%` }} />
                  </span>
                  <span className="min-w-16 text-right tabular-nums text-fg-muted">{format(value)}</span>
                </li>
              );
            })}
          </ol>
        )}
      </figure>
    </div>
  );
}
