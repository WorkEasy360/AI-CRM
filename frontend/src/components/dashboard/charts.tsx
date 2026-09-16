import * as React from "react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DashboardSummary } from "@/lib/api/types";
import { formatMoney } from "@/lib/crm/format";
import { cn } from "@/lib/utils";
import { EmptyNote, NoAccess, monthLabel } from "./stat-tile";

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** Single-series horizontal bars: one hue, direct labels, a per-bar tooltip and a table for assistive tech. */
export function DealsByStage({ data, currency }: { data: DashboardSummary; currency: string }) {
  const stages = data.deals_by_stage?.stages ?? [];
  if (data.deals_by_stage === null) return <NoAccess />;
  if (stages.length === 0) return <EmptyNote>No pipeline stages yet.</EmptyNote>;
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <div>
      <ol className="flex flex-col gap-2" aria-hidden>
        {stages.map((s) => (
          <li key={s.id} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-2 text-xs" title={`${s.name}: ${plural(s.count, "deal")}, ${formatMoney(s.amount, currency)}`}>
            <span className="truncate font-medium text-fg">{s.name}</span>
            <span className="h-2.5 overflow-hidden rounded-sm bg-bg-subtle">
              <span className={cn("block h-full rounded-sm", s.kind === "open" ? "bg-primary" : s.kind === "won" ? "bg-success" : "bg-danger")} style={{ width: `${(s.count / max) * 100}%` }} />
            </span>
            <span className="w-10 text-right tabular-nums text-fg-muted">{s.count}</span>
          </li>
        ))}
      </ol>
      <table className="sr-only">
        <caption>Deals by stage</caption>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Deals</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.count}</td>
              <td>{formatMoney(s.amount, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Six monthly columns in one hue with a baseline; the highest month is direct-labeled. */
export function RevenueTrend({ data, currency }: { data: DashboardSummary; currency: string }) {
  const trend = data.revenue_trend;
  if (trend === null) return <NoAccess />;
  if (trend.length === 0) return <EmptyNote>No won deals yet.</EmptyNote>;
  const values = trend.map((t) => Number(t.amount || 0));
  const max = Math.max(...values, 0);
  const width = 300;
  const height = 130;
  const top = 18;
  const bottom = 22;
  const plot = height - top - bottom;
  const slot = width / trend.length;
  const bar = Math.min(28, slot * 0.55);
  const peak = values.indexOf(max);
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full" role="img" aria-label={`Revenue by month, ${formatMoney(max, currency)} at most`}>
        <line x1={0} x2={width} y1={height - bottom + 0.5} y2={height - bottom + 0.5} className="stroke-border" strokeWidth={1} />
        {trend.map((t, i) => {
          const value = values[i] ?? 0;
          const h = max > 0 ? Math.max(value > 0 ? 3 : 0, (value / max) * plot) : 0;
          const x = i * slot + (slot - bar) / 2;
          const y = height - bottom - h;
          return (
            <g key={t.month}>
              <title>{`${monthLabel(t.month, true)}: ${formatMoney(t.amount, currency)} from ${plural(t.count, "won deal")}`}</title>
              <rect x={x} y={y} width={bar} height={h} rx={3} className="fill-primary" />
              {i === peak && max > 0 ? (
                <text x={x + bar / 2} y={y - 5} textAnchor="middle" className="fill-fg text-[11px] font-medium">
                  {formatMoney(value, currency)}
                </text>
              ) : null}
              <text x={x + bar / 2} y={height - 6} textAnchor="middle" className="fill-fg-subtle text-[11px]">
                {monthLabel(t.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>Revenue by month</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Won deals</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((t) => (
            <tr key={t.month}>
              <td>{t.month}</td>
              <td>{t.count}</td>
              <td>{formatMoney(t.amount, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Next three months by expected close: a hollow bar for the open value and a solid bar in the same
 * hue for the weighted value, so the pair reads by shape as well as colour. Weighted is direct-labeled.
 */
export function ForecastBars({ data, currency }: { data: DashboardSummary; currency: string }) {
  const months = data.forecast;
  if (months === null) return <NoAccess />;
  if (months.length === 0 || months.every((m) => m.count === 0)) return <EmptyNote>No open deals with an expected close date in the next three months.</EmptyNote>;
  const max = Math.max(...months.map((m) => Number(m.amount || 0)), 0);
  const width = 300;
  const height = 130;
  const top = 18;
  const bottom = 22;
  const plot = height - top - bottom;
  const slot = width / months.length;
  const bar = Math.min(34, slot * 0.5);
  const scale = (v: string) => (max > 0 ? Math.max(Number(v) > 0 ? 3 : 0, (Number(v) / max) * plot) : 0);
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full" role="img" aria-label={`Forecast by month, ${formatMoney(max, currency)} open at most`}>
        <line x1={0} x2={width} y1={height - bottom + 0.5} y2={height - bottom + 0.5} className="stroke-border" strokeWidth={1} />
        {months.map((m, i) => {
          const hOpen = scale(m.amount);
          const hWeighted = scale(m.weighted);
          const x = i * slot + (slot - bar) / 2;
          return (
            <g key={m.month}>
              <title>{`${monthLabel(m.month, true)}: ${formatMoney(m.amount, currency)} open across ${plural(m.count, "deal")}, ${formatMoney(m.weighted, currency)} weighted`}</title>
              <rect x={x + 0.5} y={height - bottom - hOpen + 0.5} width={bar - 1} height={Math.max(0, hOpen - 1)} rx={3} className="fill-primary/10 stroke-primary" strokeWidth={1} />
              <rect x={x} y={height - bottom - hWeighted} width={bar} height={hWeighted} rx={3} className="fill-primary" />
              {hOpen > 0 ? (
                <text x={x + bar / 2} y={height - bottom - hOpen - 5} textAnchor="middle" className="fill-fg text-[11px] font-medium">
                  {formatMoney(m.weighted, currency)}
                </text>
              ) : null}
              <text x={x + bar / 2} y={height - 6} textAnchor="middle" className="fill-fg-subtle text-[11px]">
                {monthLabel(m.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <ChartLegend items={[{ label: "Open value", swatch: "hollow" }, { label: "Weighted", swatch: "solid" }]} />
      <table className="sr-only">
        <caption>Forecast by expected close month</caption>
        <thead>
          <tr>
            <th>Month</th>
            <th>Open deals</th>
            <th>Open value</th>
            <th>Weighted</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <td>{m.month}</td>
              <td>{m.count}</td>
              <td>{formatMoney(m.amount, currency)}</td>
              <td>{formatMoney(m.weighted, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; swatch: "hollow" | "solid" | "success" }[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-muted" aria-label="Legend">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn("inline-block size-2.5 rounded-[2px]", item.swatch === "hollow" ? "border border-primary bg-primary/10" : item.swatch === "success" ? "bg-success" : "bg-primary")}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Open pipeline per salesperson: one hue, amount as the bar, count and weighted value as the sub-label. */
export function DealsByOwner({ data, currency, pipeline }: { data: DashboardSummary; currency: string; pipeline?: string }) {
  const owners = data.deals_by_owner;
  if (owners === null) return <NoAccess />;
  if (owners.length === 0) return <EmptyNote>No open deals assigned yet.</EmptyNote>;
  const rows = owners.slice(0, 6);
  const max = Math.max(1, ...rows.map((o) => Number(o.amount || 0)));
  const hrefFor = (id: string) => `/pipeline?view=list&owner=${encodeURIComponent(id)}${pipeline ? `&pipeline=${encodeURIComponent(pipeline)}` : ""}`;
  return (
    <div>
      <ol className="flex flex-col gap-2">
        {rows.map((o) => (
          <li key={o.id}>
            <Link href={hrefFor(o.id)} className="group block rounded-sm text-xs focus-visible:outline-2 focus-visible:outline-ring/40" title={`${o.name}: ${formatMoney(o.amount, currency)} across ${plural(o.count, "open deal")}, ${formatMoney(o.weighted, currency)} weighted`}>
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-fg group-hover:text-primary">{o.name}</span>
                <span className="shrink-0 tabular-nums text-fg">{formatMoney(o.amount, currency)}</span>
              </span>
              <span className="mt-1 block h-2 overflow-hidden rounded-sm bg-bg-subtle" aria-hidden>
                <span className="block h-full rounded-sm bg-primary" style={{ width: `${(Number(o.amount || 0) / max) * 100}%` }} />
              </span>
              <span className="mt-0.5 block text-[12px] text-fg-subtle">
                {plural(o.count, "deal")} · {formatMoney(o.weighted, currency)} weighted
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {owners.length > rows.length ? <p className="mt-2 text-[12px] text-fg-subtle">Top {rows.length} of {owners.length} salespeople.</p> : null}
    </div>
  );
}

export function TopCompanies({ data, currency }: { data: DashboardSummary; currency: string }) {
  if (data.top_companies === null) return <NoAccess />;
  if (data.top_companies.length === 0) return <EmptyNote>No deals linked to companies yet.</EmptyNote>;
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead>Company</TableHead>
          <TableHead className="text-right">Deals</TableHead>
          <TableHead className="text-right">Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.top_companies.map((c) => (
          <TableRow key={c.id}>
            <TableCell>
              <Link href={`/companies/${encodeURIComponent(c.id)}`} className="font-medium text-fg hover:text-primary hover:underline">
                {c.name}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums">{c.count}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(c.amount, currency)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
