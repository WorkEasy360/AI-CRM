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

/**
 * Sequential greens for the funnel, light (top of the funnel) to dark (won). The first four carry
 * dark text, the last two white: both are AA at 12px.
 */
const FUNNEL_RAMP = ["#bbf7d0", "#86efac", "#4ade80", "#22c55e", "#15803d", "#14532d"] as const;
const FUNNEL_DARK_TEXT_UNTIL = 3;

/**
 * The open stages plus Won, as a funnel. Each band is the number of deals that have reached that
 * stage (the stage itself and every later one), so the shape always narrows the way a funnel does.
 */
export function SalesFunnel({ data, currency }: { data: DashboardSummary; currency: string }) {
  if (data.deals_by_stage === null) return <NoAccess />;
  const stages = (data.deals_by_stage?.stages ?? []).filter((s) => s.kind !== "lost");
  if (stages.length === 0) return <EmptyNote>No pipeline stages yet.</EmptyNote>;
  const reached = stages.map((_, i) => stages.slice(i).reduce((sum, s) => sum + s.count, 0));
  const max = Math.max(1, reached[0] ?? 0);
  const last = Math.max(1, stages.length - 1);
  return (
    <div>
      <ol className="flex flex-col items-center gap-1" aria-hidden>
        {stages.map((s, i) => {
          const step = Math.round((i * (FUNNEL_RAMP.length - 1)) / last);
          const width = Math.max(34, (reached[i]! / max) * 100);
          return (
            <li
              key={s.id}
              title={`${s.name}: ${plural(reached[i]!, "deal")} reached this stage · ${plural(s.count, "deal")} here now, ${formatMoney(s.amount, currency)}`}
              className={cn("flex h-7 items-center justify-center rounded-[4px] px-2 text-xs font-semibold tabular-nums", step <= FUNNEL_DARK_TEXT_UNTIL ? "text-[#052e16]" : "text-white")}
              style={{ width: `${width}%`, backgroundColor: FUNNEL_RAMP[step] }}
            >
              <span className="truncate">
                {reached[i]!.toLocaleString()} {s.name}
              </span>
            </li>
          );
        })}
      </ol>
      <table className="sr-only">
        <caption>Sales pipeline funnel</caption>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Deals reached</th>
            <th>Deals in stage</th>
            <th>Amount in stage</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s, i) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{reached[i]}</td>
              <td>{s.count}</td>
              <td>{formatMoney(s.amount, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Categorical hues in a fixed order (validated: every adjacent pair is >= 6 dE under CVD, which the
 * legend's names and counts back up as the secondary encoding). A seventh stage folds into "Other".
 */
const STAGE_HUES = ["#3b82f6", "#16a34a", "#d97706", "#db2777", "#8b5cf6", "#0d9488"] as const;
const OTHER_HUE = "#94a3b0";

/** Every deal in the pipeline by its current stage, with the total in the middle. */
export function StageDonut({ data, currency }: { data: DashboardSummary; currency: string }) {
  if (data.deals_by_stage === null) return <NoAccess />;
  const stages = data.deals_by_stage?.stages ?? [];
  // Colour follows the stage's position in the pipeline, not its rank, so filters never repaint it.
  const slices = stages.map((s, i) => ({ id: s.id, name: s.name, count: s.count, amount: s.amount, color: STAGE_HUES[i] ?? OTHER_HUE }));
  const shown = slices.slice(0, STAGE_HUES.length);
  const rest = slices.slice(STAGE_HUES.length);
  if (rest.length > 0) {
    shown.push({
      id: "__other__",
      name: "Other",
      count: rest.reduce((sum, s) => sum + s.count, 0),
      amount: String(rest.reduce((sum, s) => sum + Number(s.amount || 0), 0)),
      color: OTHER_HUE,
    });
  }
  const total = shown.reduce((sum, s) => sum + s.count, 0);
  if (stages.length === 0) return <EmptyNote>No pipeline stages yet.</EmptyNote>;

  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const gap = total > 0 && shown.filter((s) => s.count > 0).length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" className="size-32 shrink-0 -rotate-90" role="img" aria-label={`Deals by stage: ${plural(total, "deal")} in total`}>
        <circle cx={60} cy={60} r={radius} fill="none" strokeWidth={18} className="stroke-bg-subtle" />
        {total > 0
          ? shown.map((s) => {
              if (s.count === 0) return null;
              const length = (s.count / total) * circumference;
              const dash = Math.max(0, length - gap);
              const segment = (
                <circle
                  key={s.id}
                  cx={60}
                  cy={60}
                  r={radius}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={18}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={-offset}
                >
                  <title>{`${s.name}: ${plural(s.count, "deal")}, ${formatMoney(s.amount, currency)}`}</title>
                </circle>
              );
              offset += length;
              return segment;
            })
          : null}
        <g className="rotate-90 [transform-origin:60px_60px]">
          <text x={60} y={60} textAnchor="middle" className="fill-fg text-[22px] font-bold tabular-nums">
            {total.toLocaleString()}
          </text>
          <text x={60} y={76} textAnchor="middle" className="fill-fg-subtle text-[11px]">
            Deals
          </text>
        </g>
      </svg>
      <ul className="grid min-w-0 flex-1 gap-1 text-xs">
        {shown.map((s) => (
          <li key={s.id} className="flex items-center gap-2" title={`${s.name}: ${formatMoney(s.amount, currency)}`}>
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: s.color }} aria-hidden />
            <span className="truncate text-fg">{s.name}</span>
            <span className="ml-auto tabular-nums text-fg-muted">{s.count.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Won revenue per month: a 2px line over a soft area, every month hoverable, the peak labeled. */
export function RevenueTrend({ data, currency }: { data: DashboardSummary; currency: string }) {
  const trend = data.revenue_trend;
  if (trend === null) return <NoAccess />;
  if (trend.length === 0) return <EmptyNote>No won deals yet.</EmptyNote>;
  const values = trend.map((t) => Number(t.amount || 0));
  const max = Math.max(...values, 0);
  const width = 300;
  const height = 140;
  const top = 20;
  const bottom = 22;
  const side = 14;
  const plot = height - top - bottom;
  const step = trend.length > 1 ? (width - side * 2) / (trend.length - 1) : 0;
  const points = values.map((v, i) => ({
    x: trend.length > 1 ? side + i * step : width / 2,
    y: height - bottom - (max > 0 ? (v / max) * plot : 0),
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${points.at(-1)!.x.toFixed(1)},${height - bottom} L${points[0]!.x.toFixed(1)},${height - bottom} Z`;
  const peak = values.indexOf(max);
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full overflow-visible" role="img" aria-label={`Revenue by month, ${formatMoney(max, currency)} at most`}>
        <defs>
          <linearGradient id="kl-revenue-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--kl-brand)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--kl-brand)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={width} y1={height - bottom - plot * f + 0.5} y2={height - bottom - plot * f + 0.5} className="stroke-border" strokeDasharray="3 3" strokeWidth={1} />
        ))}
        <line x1={0} x2={width} y1={height - bottom + 0.5} y2={height - bottom + 0.5} className="stroke-border" strokeWidth={1} />
        <path d={area} fill="url(#kl-revenue-area)" />
        <path d={line} fill="none" stroke="var(--kl-brand)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {trend.map((t, i) => {
          const p = points[i]!;
          return (
            <g key={t.month}>
              <title>{`${monthLabel(t.month, true)}: ${formatMoney(t.amount, currency)} from ${plural(t.count, "won deal")}`}</title>
              {/* The hit target is wider than the mark so the month is easy to hover. */}
              <rect x={p.x - Math.max(step, 24) / 2} y={top - 10} width={Math.max(step, 24)} height={plot + 10} fill="transparent" />
              <circle cx={p.x} cy={p.y} r={4} fill="var(--kl-brand)" stroke="var(--kl-surface)" strokeWidth={2} />
              {i === peak && max > 0 ? (
                <text x={p.x} y={p.y - 9} textAnchor={i === trend.length - 1 ? "end" : i === 0 ? "start" : "middle"} className="fill-fg text-[11px] font-medium">
                  {formatMoney(values[i] ?? 0, currency)}
                </text>
              ) : null}
              <text x={p.x} y={height - 6} textAnchor="middle" className="fill-fg-subtle text-[11px]">
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
              <Link prefetch={false} href={`/companies/${encodeURIComponent(c.id)}`} className="font-medium text-fg hover:text-primary hover:underline">
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
