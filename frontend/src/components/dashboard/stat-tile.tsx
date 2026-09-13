import * as React from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
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

export function Panel({ title, subtitle, action, children, className }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col rounded-md border border-border bg-surface", className)}>
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
