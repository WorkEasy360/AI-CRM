import * as React from "react";
import { ChartLegend } from "@/components/dashboard/charts";
import { EmptyNote, monthLabel } from "@/components/dashboard/stat-tile";
import type { Forecast } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";

/**
 * One group per month in the period: a hollow bar for the open pipeline, a solid bar in the same hue
 * for the weighted value and a green bar for what is already won. Only the largest weighted month is
 * direct-labeled; the tooltip and the table carry every figure.
 */
export function ForecastSeriesChart({ series, currency }: { series: Forecast["series"]; currency: string }) {
  if (series.length === 0) return <EmptyNote>No months in this period.</EmptyNote>;
  const max = Math.max(...series.flatMap((m) => [Number(m.pipeline || 0), Number(m.won || 0)]), 0);
  if (max === 0) return <EmptyNote>No open or won deals fall in this period.</EmptyNote>;
  const width = 600;
  const height = 160;
  const top = 20;
  const bottom = 24;
  const plot = height - top - bottom;
  const slot = width / series.length;
  const group = Math.min(64, slot * 0.7);
  const bar = group / 2 - 2;
  const scale = (v: string) => (max > 0 ? Math.max(Number(v) > 0 ? 3 : 0, (Number(v) / max) * plot) : 0);
  const weighted = series.map((m) => Number(m.weighted || 0));
  const peak = weighted.indexOf(Math.max(...weighted));
  const withYear = new Set(series.map((m) => m.month.slice(0, 4))).size > 1;
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full" role="img" aria-label={`Pipeline, weighted and won by month, ${formatMoney(max, currency)} at most`}>
        <line x1={0} x2={width} y1={height - bottom + 0.5} y2={height - bottom + 0.5} className="stroke-border" strokeWidth={1} />
        {series.map((m, i) => {
          const x0 = i * slot + (slot - group) / 2;
          const hOpen = scale(m.pipeline);
          const hWeighted = scale(m.weighted);
          const hWon = scale(m.won);
          const base = height - bottom;
          return (
            <g key={m.month}>
              <title>{`${monthLabel(m.month, true)}: ${formatMoney(m.pipeline, currency)} open across ${m.open_count} ${m.open_count === 1 ? "deal" : "deals"}, ${formatMoney(m.weighted, currency)} weighted, ${formatMoney(m.won, currency)} won from ${m.won_count} ${m.won_count === 1 ? "deal" : "deals"}`}</title>
              <rect x={x0 + 0.5} y={base - hOpen + 0.5} width={Math.max(0, bar - 1)} height={Math.max(0, hOpen - 1)} rx={3} className="fill-primary/10 stroke-primary" strokeWidth={1} />
              <rect x={x0} y={base - hWeighted} width={bar} height={hWeighted} rx={3} className="fill-primary" />
              <rect x={x0 + bar + 4} y={base - hWon} width={bar} height={hWon} rx={3} className="fill-success" />
              {i === peak && weighted[i]! > 0 ? (
                <text x={x0 + bar / 2} y={base - Math.max(hOpen, hWeighted) - 5} textAnchor="middle" className="fill-fg text-[11px] font-medium">
                  {formatMoney(m.weighted, currency)}
                </text>
              ) : null}
              <text x={x0 + group / 2} y={height - 7} textAnchor="middle" className="fill-fg-subtle text-[11px]">
                {monthLabel(m.month, withYear)}
              </text>
            </g>
          );
        })}
      </svg>
      <ChartLegend items={[{ label: "Pipeline (open value)", swatch: "hollow" }, { label: "Weighted", swatch: "solid" }, { label: "Won", swatch: "success" }]} />
      <table className="sr-only">
        <caption>Forecast by month</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Open deals</th>
            <th>Pipeline</th>
            <th>Weighted</th>
            <th>Won deals</th>
            <th>Won</th>
          </tr>
        </thead>
        <tbody>
          {series.map((m) => (
            <tr key={m.month}>
              <td>{m.month}</td>
              <td>{m.open_count}</td>
              <td>{formatMoney(m.pipeline, currency)}</td>
              <td>{formatMoney(m.weighted, currency)}</td>
              <td>{m.won_count}</td>
              <td>{formatMoney(m.won, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
