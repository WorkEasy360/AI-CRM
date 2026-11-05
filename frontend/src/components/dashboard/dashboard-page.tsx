"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, CalendarDays, IndianRupee, Layers, ListTodo, Phone, Scale, Target, Trophy, UserPlus, UserRound, Users } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listPipelines } from "@/lib/api/crm";
import { getDashboard } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import { DASHBOARD_PERIODS, type DashboardGrowth, type DashboardPeriod } from "@/lib/api/types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { useListParams } from "@/lib/crm/use-list-params";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { DashboardTabs } from "./dashboard-tabs";
import {
  AiInsightsCard,
  BusinessSummary,
  PipelineOverview,
  QuickActionsGrid,
  RecentActivities,
  RevenueBars,
  SourceDonut,
  TodayAgenda,
  TopTeam,
  UpcomingOverdue,
} from "./dashboard-widgets";
import { KpiTile, Panel, PanelLink, StatTile, fmtCount, fmtPercent, percentChange, pointChange } from "./stat-tile";

import dynamic from "next/dynamic";

// The numbers are the dashboard; the older detail charts are what you read next, so they load as
// their own chunk below the WorkEasy360 layout.
const DealsByOwner = dynamic(() => import("./charts").then((m) => m.DealsByOwner), { ssr: false });
const SalesFunnel = dynamic(() => import("./charts").then((m) => m.SalesFunnel), { ssr: false });
const StageDonut = dynamic(() => import("./charts").then((m) => m.StageDonut), { ssr: false });
const ForecastBars = dynamic(() => import("./charts").then((m) => m.ForecastBars), { ssr: false });
const TopCompanies = dynamic(() => import("./charts").then((m) => m.TopCompanies), { ssr: false });

const PERIOD_LABELS: Record<DashboardPeriod, string> = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", "365d": "Last 12 months" };
const ALL_PIPELINES = "__all__";
const TREND_OPTIONS = [3, 6, 12] as const;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The current month and the eleven before it, newest first ("2026-11", "2026-10", …). */
export function recentMonths(now: Date = new Date()): string[] {
  return Array.from({ length: 12 }, (_, i) => monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
}

function monthName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(new Date(y!, m! - 1, 1));
}

/** The URL's period, or this month by default (the WorkEasy360 month selector). */
export function periodOf(value: string | undefined, now: Date = new Date()): string {
  if ((DASHBOARD_PERIODS as readonly string[]).includes(value ?? "")) return value as string;
  if (value && MONTH.test(value) && value <= monthKey(now)) return value;
  return monthKey(now);
}

function periodLabel(period: string): string {
  return (PERIOD_LABELS as Record<string, string>)[period] ?? monthName(period);
}

/** Growth from the start of the period: "↑ 18%" when the count rose from what existed then. */
function growthChange(growth: DashboardGrowth | null | undefined, versus: string) {
  return growth ? percentChange(growth.count, growth.previous, versus) : null;
}

/** Sales numbers only: everything here is scoped to what the member may see, nothing technical. */
export function DashboardPage() {
  const { data: session } = useSession();
  const active = session?.active;
  const currency = active?.organization.base_currency ?? "USD";
  const { params, setParam, setParams } = useListParams(["period", "pipeline", "months"]);
  const period = periodOf(params.period);
  const pipeline = params.pipeline;
  const months = TREND_OPTIONS.find((m) => String(m) === params.months) ?? 6;

  const summary = useQuery({
    queryKey: queryKeys.dashboard(period, pipeline, months),
    queryFn: () => getDashboard(period, pipeline, months),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), staleTime: 5 * 60_000 });
  const pipelineList = pipelines.data?.results ?? [];
  const data = summary.data;
  const label = periodLabel(period);
  const versus = MONTH.test(period) ? "compared with the start of the month" : `compared with ${label.replace(/^Last /, "the start of the last ").toLowerCase()}`;
  const pipelineQs = pipeline ? `&pipeline=${encodeURIComponent(pipeline)}` : "";
  const noActivities = data && !data.activities ? "Your role does not include Activities" : undefined;
  const lead = data?.lead_conversion;
  const won = data?.deals_won;
  const previous = data?.previous ?? null;
  const winRateChange = previous ? pointChange(data?.win_rate, previous.win_rate, "compared with the previous period") : null;
  const totals = data?.totals;
  const canActivities = hasPermission(active, "activities.view");

  return (
    <div className="mx-auto max-w-[96rem]">
      <PageHeader
        icon={UserRound}
        title={`${greeting(session?.user.display_name || session?.user.email)}! 👋`}
        description="Here's what's happening in your CRM today."
        actions={
          <>
            <DashboardTabs active="overview" />
            {pipelineList.length > 1 ? (
              <Select value={pipeline ?? ALL_PIPELINES} onValueChange={(v) => setParam("pipeline", v === ALL_PIPELINES ? undefined : v)}>
                <SelectTrigger className="h-9 w-40" aria-label="Pipeline">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PIPELINES}>All pipelines</SelectItem>
                  {pipelineList.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Select value={period} onValueChange={(v) => setParam("period", v === monthKey(new Date()) ? undefined : v)}>
              <SelectTrigger className="h-9 w-40 font-medium" aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {recentMonths().map((m) => (
                  <SelectItem key={m} value={m}>
                    {monthName(m)}
                  </SelectItem>
                ))}
                <SelectSeparator />
                {DASHBOARD_PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PERIOD_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      {summary.isError ? (
        <EmptyState title="Could not load the dashboard" description={errorMessage(summary.error)} action={<Button variant="secondary" onClick={() => summary.refetch()}>Retry</Button>} />
      ) : (
        <div className={cn("grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]", summary.isFetching && "opacity-80")} aria-busy={summary.isFetching || undefined}>
          <div className="grid min-w-0 gap-4">
            <section aria-label="Key figures" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 2xl:grid-cols-5">
              <KpiTile tone="green" icon={<Users />} label="Total Contacts" value={data ? fmtCount(totals?.contacts?.count) : undefined} change={growthChange(totals?.contacts, versus)} changeNote="" sub={totals?.contacts === null ? "No access" : undefined} href="/contacts" />
              <KpiTile tone="blue" icon={<Building2 />} label="Companies" value={data ? fmtCount(totals?.companies?.count) : undefined} change={growthChange(totals?.companies, versus)} changeNote="" sub={totals?.companies === null ? "No access" : undefined} href="/companies" />
              <KpiTile tone="purple" icon={<Layers />} label="Total Deals" value={data ? fmtCount(totals?.deals?.count) : undefined} change={growthChange(totals?.deals, versus)} changeNote="" sub={totals?.deals === null ? "No access" : undefined} href={`/pipeline${pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : ""}`} />
              <KpiTile tone="orange" icon={currency === "INR" ? <IndianRupee /> : <Trophy />} label="Expected Revenue" value={data ? (data.weighted_pipeline ? formatMoney(data.weighted_pipeline.amount, currency) : "—") : undefined} sub="Weighted open pipeline" href="/dashboard/forecast" />
              <KpiTile tone="pink" icon={<Target />} label="Win Rate" value={data ? fmtPercent(data.win_rate) : undefined} change={winRateChange} changeNote="" sub={won && data?.deals_lost ? `${won.count} won · ${data.deals_lost.count} lost` : label} />
            </section>

            <section aria-label="Pipeline and revenue" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <Panel title="Sales Pipeline Overview" subtitle={data?.deals_by_stage?.pipeline?.name ?? undefined}>
                {!data ? <Skeleton className="h-28 w-full" /> : <PipelineOverview data={data} currency={currency} />}
              </Panel>
              <Panel
                title="Revenue Trend"
                subtitle="Won deals by month"
                action={
                  <Select value={String(months)} onValueChange={(v) => setParams({ months: v === "6" ? undefined : v })}>
                    <SelectTrigger className="h-8 w-36 text-xs" aria-label="Revenue trend range">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TREND_OPTIONS.map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          Last {m} Months
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              >
                {!data ? <Skeleton className="h-40 w-full" /> : <RevenueBars data={data} currency={currency} />}
              </Panel>
            </section>

            <section aria-label="Business summary" className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              <Panel title="Key Business Summary" subtitle={`Logged · ${label}`}>
                {!data ? <Skeleton className="h-32 w-full" /> : <BusinessSummary data={data} />}
              </Panel>
              <Panel title="Deals by Source" subtitle={`New deals · ${label}`}>
                {!data ? <Skeleton className="h-32 w-full" /> : <SourceDonut data={data} />}
              </Panel>
              <Panel title="Top Performing Team" subtitle={`Won · ${label}`}>
                {!data ? <Skeleton className="h-32 w-full" /> : <TopTeam data={data} currency={currency} />}
              </Panel>
            </section>

            <section aria-label="Activity and shortcuts" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <RecentActivities enabled={canActivities} />
              <QuickActionsGrid active={active} />
            </section>
          </div>

          <aside aria-label="Today" className="grid min-w-0 content-start gap-4">
            <TodayAgenda enabled={canActivities} />
            {data ? <UpcomingOverdue data={data} /> : <Skeleton className="h-32 w-full" />}
            <AiInsightsCard data={data} currency={currency} />
          </aside>

          <details className="group xl:col-span-2">
            <summary className="cursor-pointer select-none text-sm font-semibold text-fg-muted hover:text-fg">More insights</summary>
            <div className="mt-3 grid gap-3">
              <section aria-label="Sales summary" className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                <StatTile label="Pipeline value" value={data ? (data.open_pipeline ? formatMoney(data.open_pipeline.amount, currency) : "—") : undefined} sub={data?.open_pipeline ? `${data.open_pipeline.count} open ${data.open_pipeline.count === 1 ? "deal" : "deals"}` : undefined} hint="Right now" href={`/pipeline${pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : ""}`} />
                <StatTile label="Weighted pipeline" value={data ? (data.weighted_pipeline ? formatMoney(data.weighted_pipeline.amount, currency) : "—") : undefined} sub={data?.weighted_pipeline ? "Value × probability" : undefined} hint="Right now" href="/dashboard/forecast" />
                <StatTile label="Won revenue" value={data ? (won ? formatMoney(won.amount, currency) : "—") : undefined} hint={label} subTone="success" href={`/pipeline?view=list&status=won${pipelineQs}`} />
                <StatTile label="Deals won" value={data ? fmtCount(won?.count) : undefined} sub={data && won && data.win_rate !== null ? `${fmtPercent(data.win_rate)} win rate` : undefined} hint={label} href={`/pipeline?view=list&status=won${pipelineQs}`} />
                <StatTile label="Deals lost" value={data ? fmtCount(data.deals_lost?.count) : undefined} sub={data?.deals_lost ? formatMoney(data.deals_lost.amount, currency) : undefined} hint={label} href={`/pipeline?view=list&status=lost${pipelineQs}`} />
              </section>
              <section aria-label="Activity summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
                <StatTile size="sm" label="Tasks due" icon={<ListTodo />} value={data ? fmtCount(data.activities?.tasks_due) : undefined} sub={data?.activities ? (data.activities.tasks_overdue > 0 ? `${data.activities.tasks_overdue.toLocaleString()} overdue` : "Nothing overdue") : undefined} subTone={data?.activities && data.activities.tasks_overdue > 0 ? "danger" : "default"} hint={noActivities ?? "Open tasks"} href="/activities?tab=tasks&due=today" />
                <StatTile size="sm" label="Meetings" icon={<CalendarDays />} value={data ? fmtCount(data.activities?.meetings_upcoming) : undefined} sub={data?.activities ? "Upcoming this week" : undefined} hint={noActivities} href="/activities?tab=calendar" />
                <StatTile size="sm" label="Calls" icon={<Phone />} value={data ? fmtCount(data.activities?.calls_completed) : undefined} sub={data?.activities ? `${data.activities.calls_upcoming.toLocaleString()} upcoming` : undefined} hint={noActivities} href="/activities?tab=calls" />
                <StatTile size="sm" label="Lead conversion" icon={<UserPlus />} value={data ? (lead ? fmtPercent(lead.rate) : "—") : undefined} sub={lead ? `${lead.converted.toLocaleString()} converted / ${lead.created.toLocaleString()} created` : undefined} hint={label} href="/contacts" />
                <StatTile size="sm" label="Average deal size" icon={<Scale />} value={data ? (data.average_deal_size !== null ? formatMoney(data.average_deal_size, currency) : "—") : undefined} hint={`Won deals · ${label.toLowerCase()}`} href={`/pipeline?view=list&status=won${pipelineQs}`} />
              </section>
              <section aria-label="Charts" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Panel title="Sales Funnel" subtitle="Deals that reached each stage">
                  {!data ? <Skeleton className="h-40 w-full" /> : <SalesFunnel data={data} currency={currency} />}
                </Panel>
                <Panel title="Deal Stage" subtitle="Every deal by its current stage">
                  {!data ? <Skeleton className="h-40 w-full" /> : <StageDonut data={data} currency={currency} />}
                </Panel>
                <Panel title="Forecast" subtitle="Next 3 months by expected close" action={<PanelLink href="/dashboard/forecast">Details</PanelLink>}>
                  {!data ? <Skeleton className="h-40 w-full" /> : <ForecastBars data={data} currency={currency} />}
                </Panel>
                <Panel title="Deals by owner" subtitle="Open pipeline per salesperson">
                  {!data ? <Skeleton className="h-40 w-full" /> : <DealsByOwner data={data} currency={currency} pipeline={pipeline} />}
                </Panel>
              </section>
              <Panel title="Top companies" subtitle="Open and won pipeline">
                {!data ? <Skeleton className="h-24 w-full" /> : <TopCompanies data={data} currency={currency} />}
              </Panel>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/** "Good Afternoon, Manoj" by the viewer's local clock; the first word of the name, or the email's local part. */
export function greeting(name: string | undefined, now: Date = new Date()): string {
  const hour = now.getHours();
  const part = hour < 12 ? "Good Morning" : hour < 17 ? "Good Afternoon" : "Good Evening";
  const first = (name ?? "").split("@")[0]!.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}
