"use client";

import * as React from "react";
import Link from "next/link";
import { BarChart3, Layers, Target, Trophy, Users } from "lucide-react";
import { UserMenu } from "@/components/shell/user-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { ActiveContext, DashboardSummary, Session } from "@/lib/api/types";
import { formatMoney } from "@/lib/crm/format";
import { cn } from "@/lib/utils";
import { StageBars, TodaysFollowUps } from "./dashboard-widgets";
import { ChangeBadge, Panel, fmtCount, fmtPercent, percentChange, pointChange, type KpiChange } from "./stat-tile";

const VERSUS = "compared with the previous period";

function Figure({
  href,
  label,
  value,
  change,
  note,
  icon: Icon,
  tint,
}: {
  href: string;
  label: string;
  value: string | undefined;
  change?: KpiChange | null;
  /** Shown instead of a change this figure has no comparison for. */
  note?: string;
  icon: React.ComponentType<{ className?: string }>;
  tint: string;
}) {
  return (
    <Link href={href} className="flex min-w-0 items-start gap-2.5 rounded-xl border border-border bg-surface p-3 shadow-sm focus-visible:outline-2 focus-visible:outline-ring">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", tint)} aria-hidden>
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-fg-muted">{label}</span>
        {/* A long amount wraps rather than losing digits. */}
        {value === undefined ? <Skeleton className="mt-1 h-6 w-16" /> : <span className="block text-lg leading-tight font-bold tabular-nums [overflow-wrap:anywhere] text-fg">{value}</span>}
        {change ? <ChangeBadge change={change} /> : note ? <span className="block truncate text-xs text-fg-muted">{note}</span> : null}
      </span>
    </Link>
  );
}

/** The phone's Home: a greeting, the four figures that matter, the pipeline and today's follow-ups. */
export function PhoneHome({
  session,
  active,
  data,
  currency,
  periodSelect,
  canActivities,
  hrefs,
  fullHref,
}: {
  session: Session | null | undefined;
  active: ActiveContext | null | undefined;
  data: DashboardSummary | undefined;
  currency: string;
  periodSelect: React.ReactNode;
  canActivities: boolean;
  hrefs: { open: string; won: string };
  fullHref: string;
}) {
  // Someone without a name set has their email as display_name; greet them by the part before the @.
  const first = (session?.user.display_name || session?.user.email || "").split("@")[0]!.trim().split(/\s+/)[0] ?? "";
  const leads = data?.leads;
  const won = data?.deals_won;
  const open = data?.open_pipeline;
  const previous = data?.previous ?? null;
  const noAccess = "No access";

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center gap-2.5">
        {session ? <UserMenu session={session} /> : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg leading-tight font-bold text-fg">
            Hello{first ? ` ${first}` : ""} <span aria-hidden>👋</span>
          </h1>
          <p className="truncate text-xs text-fg-muted">Your sales overview</p>
        </div>
        <div className="shrink-0">{periodSelect}</div>
      </div>

      <section aria-label="Key figures" className="grid grid-cols-2 gap-2.5">
        <Figure href="/contacts" label="Total Leads" icon={Users} tint="bg-success-soft text-success" value={data ? fmtCount(leads?.total) : undefined} change={leads ? percentChange(leads.total, leads.previous_total, VERSUS) : null} note={leads === null ? noAccess : undefined} />
        <Figure href={hrefs.open} label="Open Deals" icon={Layers} tint="bg-accent-soft text-accent" value={data ? fmtCount(open?.count) : undefined} note={open ? formatMoney(open.amount, currency) : data && open === null ? noAccess : undefined} />
        <Figure href={hrefs.won} label="Won Deals" icon={Trophy} tint="bg-warning-soft text-warning" value={data ? (won ? formatMoney(won.amount, currency) : "—") : undefined} change={won && previous ? percentChange(Number(won.amount), Number(previous.deals_won.amount), VERSUS) : null} />
        <Figure href="/pipeline?tab=analytics" label="Conversion" icon={Target} tint="bg-brand-soft text-brand" value={data ? fmtPercent(data.win_rate) : undefined} change={previous ? pointChange(data?.win_rate, previous.win_rate, VERSUS) : null} />
      </section>

      <Panel title="Sales Pipeline (Deals)">{!data ? <Skeleton className="h-56 w-full" /> : <StageBars data={data} currency={currency} />}</Panel>

      <TodaysFollowUps enabled={canActivities} active={active} />

      <Link href={fullHref} className="flex min-h-11 items-center justify-center gap-2 text-sm font-semibold text-primary">
        <BarChart3 className="size-4" aria-hidden /> View full dashboard
      </Link>
    </div>
  );
}
