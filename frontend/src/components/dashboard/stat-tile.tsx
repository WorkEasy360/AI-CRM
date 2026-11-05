import * as React from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function fmtCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

export function fmtPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)}%`;
}

/** "2026-09" -> "Sep" in the viewer's locale; unknown keys pass through. */
export function monthLabel(key: string, withYear = false): string {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  return new Intl.DateTimeFormat(undefined, withYear ? { month: "short", year: "numeric" } : { month: "short" }).format(new Date(year, month - 1, 1));
}

export interface StatTileProps {
  label: string;
  /** Undefined renders a skeleton. */
  value: string | undefined;
  /** One line under the number: a count, an amount, or a note. */
  sub?: string;
  /** Fallback under the number when `sub` is absent (usually the period). */
  hint?: string;
  /** Colour the sub-line for attention (overdue work) or for won revenue. */
  subTone?: "default" | "danger" | "success";
  icon?: React.ReactNode;
  /** The whole tile becomes a link. */
  href?: string;
  /** Larger number for the headline figure. */
  emphasis?: boolean;
  /** Compact tiles for the secondary row. */
  size?: "md" | "sm";
  className?: string;
}

/** A labelled number. With `href` the tile is one link, so every figure leads somewhere useful. */
export function StatTile({ label, value, sub, hint, subTone = "default", icon, href, emphasis, size = "md", className }: StatTileProps) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg-muted [&_svg]:size-3.5 [&_svg]:text-fg-subtle">
        {icon}
        <span className="truncate">{label}</span>
        {href ? <ArrowUpRight className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden /> : null}
      </div>
      {value === undefined ? (
        <Skeleton className={cn("mt-1.5 w-20", size === "sm" ? "h-5" : "h-7")} />
      ) : (
        <p className={cn("mt-1 truncate font-semibold tabular-nums tracking-tight text-fg", size === "sm" ? "text-lg" : emphasis ? "text-3xl" : "text-2xl")}>{value}</p>
      )}
      <p className={cn("mt-0.5 truncate text-xs", subTone === "danger" ? "font-medium text-danger" : subTone === "success" ? "text-success" : "text-fg-subtle")}>{sub ?? hint ?? " "}</p>
    </>
  );
  const classes = cn("group block min-w-0 rounded-md border border-border bg-surface", size === "sm" ? "px-3 py-2" : "px-4 py-3", emphasis && "border-primary/40", className);
  if (href) {
    return (
      <Link href={href} className={cn(classes, "transition-colors hover:border-border-strong hover:bg-bg-subtle/60 focus-visible:outline-2 focus-visible:outline-ring/40")}>
        {body}
      </Link>
    );
  }
  return <div className={classes}>{body}</div>;
}

/** Icon disc tints for the headline KPIs. Each icon colour is >= 3:1 on its own tint. */
const KPI_TONES = {
  green: "bg-[#dcfce7] text-[#15803d]",
  orange: "bg-[#ffedd5] text-[#c2410c]",
  amber: "bg-[#fef3c7] text-[#b45309]",
  blue: "bg-[#dbeafe] text-[#1d4ed8]",
  purple: "bg-[#f3e8ff] text-[#7e22ce]",
  pink: "bg-[#fce7f3] text-[#be185d]",
  red: "bg-[#fee2e2] text-[#b91c1c]",
} as const;

export type KpiTone = keyof typeof KPI_TONES;

/** A change against the previous period: an arrow, a short text and a full sentence for screen readers. */
export interface KpiChange {
  direction: "up" | "down" | "flat";
  text: string;
  description: string;
  /** For durations and backlogs: a fall is the good news (shown green). */
  lowerIsBetter?: boolean;
}

/** Percent change of a count or amount; null when there is nothing to compare against. */
export function percentChange(current: number | null | undefined, previous: number | null | undefined, versus: string): KpiChange | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? { direction: "flat", text: "0%", description: `No change ${versus}` } : null;
  const pct = Math.round(((current - previous) / previous) * 100);
  const direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const abs = Math.abs(pct).toLocaleString();
  return { direction, text: `${abs}%`, description: direction === "flat" ? `No change ${versus}` : `${direction === "up" ? "Up" : "Down"} ${abs}% ${versus}` };
}

/** Change in percentage points (for rates). */
export function pointChange(current: number | null | undefined, previous: number | null | undefined, versus: string): KpiChange | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  const diff = Math.round(current - previous);
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const abs = Math.abs(diff);
  const unit = abs === 1 ? "point" : "points";
  return { direction, text: `${abs} pts`, description: direction === "flat" ? `No change ${versus}` : `${direction === "up" ? "Up" : "Down"} ${abs} ${unit} ${versus}` };
}

const CHANGE_TONE = { up: "text-success", down: "text-danger", flat: "text-fg-muted" } as const;
const INVERSE_TONE = { up: "text-danger", down: "text-success", flat: "text-fg-muted" } as const;
const CHANGE_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const;

function ChangeLine({ change, note }: { change: KpiChange; note: string }) {
  const Icon = CHANGE_ICON[change.direction];
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs">
      <span className={cn("inline-flex shrink-0 items-center gap-0.5 font-semibold tabular-nums", (change.lowerIsBetter ? INVERSE_TONE : CHANGE_TONE)[change.direction])} aria-hidden>
        <Icon className="size-3.5" />
        {change.text}
      </span>
      <span className="truncate text-fg-subtle" aria-hidden>
        {note}
      </span>
      <span className="sr-only">{change.description}</span>
    </span>
  );
}

/** A headline figure with a tinted icon disc, as on the WorkEasy360 dashboard. The tile is one link. */
export function KpiTile({
  label,
  value,
  sub,
  icon,
  tone,
  href,
  change,
  changeNote = "vs prev. period",
}: {
  label: string;
  value: string | undefined;
  sub?: string;
  icon: React.ReactNode;
  tone: KpiTone;
  href?: string;
  /** Shown in place of ``sub`` when there is a previous period to compare with. */
  change?: KpiChange | null;
  changeNote?: string;
}) {
  const body = (
    <>
      <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-full [&_svg]:size-5", KPI_TONES[tone])} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-fg-muted">{label}</span>
        {value === undefined ? <Skeleton className="mt-1 h-7 w-20" /> : <span className="block truncate text-2xl font-bold tabular-nums tracking-tight text-fg">{value}</span>}
        {change && value !== undefined ? <ChangeLine change={change} note={changeNote} /> : <span className="block truncate text-xs text-fg-subtle">{sub ?? "\u00a0"}</span>}
      </span>
    </>
  );
  const classes = "group flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 shadow-sm";
  return href ? (
    <Link href={href} className={cn(classes, "transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring/40")}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}

export function Panel({ title, subtitle, action, children, className }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col rounded-lg border border-border bg-surface shadow-sm", className)}>
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {subtitle ? <p className="truncate text-xs text-fg-subtle">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      <div className="flex-1 px-4 py-3">{children}</div>
    </section>
  );
}

export function PanelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-primary hover:underline [&_svg]:size-3.5">
      {children}
      <ArrowUpRight aria-hidden />
    </Link>
  );
}

export function NoAccess() {
  return <p className="py-6 text-center text-xs text-fg-muted">Your role does not include access to this data.</p>;
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-xs text-fg-muted">{children}</p>;
}
