"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Building2, CalendarDays, Gauge, Layers, ListTodo, Phone, Scale, Target, Trophy, UserPlus, UserRound, Users, UsersRound } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listPipelines } from "@/lib/api/crm";
import { getDashboard } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import { DASHBOARD_PERIODS, type DashboardPeriod } from "@/lib/api/types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { monthKey, monthName } from "@/lib/crm/periods";
import { useListParams } from "@/lib/crm/use-list-params";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { useIsPhone } from "@/lib/use-is-phone";
import { cn } from "@/lib/utils";
import { DashboardTabs } from "./dashboard-tabs";
import { PhoneHome } from "./phone-home";
import {
  AiInsightsCard,
  BusinessSummary,
  LeadsDonut,
  PendingTasks,
  PipelineOverview,
  QuickActionsGrid,
  QuickActionsList,
  RecentActivities,
  RevenueBars,
  SourceDonut,
  StageBars,
  TodaysFollowUps,
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

/** The current month and the eleven before it, newest first ("2026-11", "2026-10", …). */
export function recentMonths(now: Date = new Date()): string[] {
  return Array.from({ length: 12 }, (_, i) => monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
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

const VERSUS = "compared with the previous period";

/** Sales numbers only: everything here is scoped to what the member may see, nothing technical. */
export function DashboardPage() {
  const { data: session } = useSession();
  const active = session?.active;
  const currency = active?.organization.base_currency ?? "USD";
  const { params, setParam, setParams } = useListParams(["period", "pipeline", "months", "owner", "view"]);
  const phone = useIsPhone();
  const period = periodOf(params.period);
  const pipeline = params.pipeline;
  const months = TREND_OPTIONS.find((m) => String(m) === params.months) ?? 6;
  const owner = params.owner === "all" ? "all" : "me";
  const mine = owner === "me";

  const summary = useQuery({
    queryKey: queryKeys.dashboard(period, pipeline, months, owner),
    queryFn: () => getDashboard(period, pipeline, months, owner),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), staleTime: 5 * 60_000 });
  const pipelineList = pipelines.data?.results ?? [];
  const data = summary.data;
  const label = periodLabel(period);
  const pipelineQs = pipeline ? `&pipeline=${encodeURIComponent(pipeline)}` : "";
  const ownerQs = mine ? "&owner=me" : "";
  const noActivities = data && !data.activities ? "Your role does not include Activities" : undefined;
  const lead = data?.lead_conversion;
  const won = data?.deals_won;
  const leads = data?.leads;
  const previous = data?.previous ?? null;
  const canActivities = hasPermission(active, "activities.view");
  // These tiles and lists count deals closed in the selected period, so their links carry it.
  const wonHref = `/pipeline?view=list&status=won&closed_period=${encodeURIComponent(period)}${ownerQs}${pipelineQs}`;
  const lostHref = `/pipeline?view=list&status=lost&closed_period=${encodeURIComponent(period)}${ownerQs}${pipelineQs}`;
  const openHref = `/pipeline?view=list&status=open${ownerQs}${pipelineQs}`;
  const noLeads = leads === null ? "No access" : undefined;
  const noDeals = data && data.open_pipeline === null ? "No access" : undefined;
  // Someone without a name set has their email as display_name; greet them by the part before the @.
  const userName = (session?.user.display_name || session?.user.email || "").split("@")[0]!.trim();
  const periodSelect = (
    <Select value={period} onValueChange={(v) => setParam("period", v === monthKey() ? undefined : v)}>
      <SelectTrigger className={cn("h-9 font-medium", phone ? "w-32" : "w-40")} aria-label="Period">
        {phone ? null : <CalendarDays className="size-4 shrink-0 text-fg-muted" aria-hidden />}
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
  );

  // Phones get a focused Home; everything else on this page stays one tap away.
  if (phone && params.view !== "full") {
    if (summary.isError) {
      return <EmptyState title="Could not load the dashboard" description={errorMessage(summary.error)} action={<Button variant="secondary" onClick={() => summary.refetch()}>Retry</Button>} />;
    }
    return <PhoneHome session={session} active={active} data={data} currency={currency} periodSelect={periodSelect} canActivities={canActivities} hrefs={{ open: openHref, won: wonHref }} fullHref="/dashboard?view=full" />;
  }

  return (
    <div className="w-full">
      <PageHeader
        icon={Gauge}
        title={userName ? `Welcome, ${userName}` : "Welcome"}
        description="Your CRM overview, today's work, sales pipeline and key performance."
        actions={
          <>
            <DashboardTabs active="overview" />
            {periodSelect}
            <Select value={owner} onValueChange={(v) => setParam("owner", v === "me" ? undefined : v)}>
              <SelectTrigger className="h-9 w-40 font-medium" aria-label="Records">
                <UserRound className="size-4 shrink-0 text-fg-muted" aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">My Records</SelectItem>
                <SelectItem value="all">All Records</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
      />

      {summary.isError ? (
        <EmptyState title="Could not load the dashboard" description={errorMessage(summary.error)} action={<Button variant="secondary" onClick={() => summary.refetch()}>Retry</Button>} />
      ) : (
        <div className={cn("grid gap-4", summary.isFetching && "opacity-80")} aria-busy={summary.isFetching || undefined}>
          <section aria-label="Key figures" className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3 xl:grid-cols-5">
            <KpiTile tone="green" icon={<Users />} label="Total Leads" value={data ? fmtCount(leads?.total) : undefined} change={leads ? percentChange(leads.total, leads.previous_total, VERSUS) : null} changeNote="vs previous period" sub={noLeads} href="/contacts" />
            <KpiTile tone="blue" icon={<UsersRound />} label="Active Leads" value={data ? fmtCount(leads?.active) : undefined} change={leads ? percentChange(leads.active, leads.previous_active, VERSUS) : null} changeNote="vs previous period" sub={noLeads ?? "Still in progress"} href="/contacts" />
            <KpiTile tone="purple" icon={<Layers />} label="Open Deals" value={data ? (data.open_pipeline ? formatMoney(data.open_pipeline.amount, currency) : "—") : undefined} change={data?.open_pipeline && previous?.open_amount !== undefined ? percentChange(Number(data.open_pipeline.amount), Number(previous.open_amount), VERSUS) : null} changeNote="vs previous period" sub={noDeals ?? (data?.open_pipeline ? `${data.open_pipeline.count.toLocaleString()} open` : undefined)} href={openHref} />
            <KpiTile tone="orange" icon={<Trophy />} label="Won Deals" value={data ? (won ? formatMoney(won.amount, currency) : "—") : undefined} change={won && previous ? percentChange(Number(won.amount), Number(previous.deals_won.amount), VERSUS) : null} changeNote="vs previous period" sub={noDeals ?? (won ? `${won.count.toLocaleString()} won` : undefined)} href={wonHref} />
            <KpiTile tone="green" icon={<Target />} label="Conversion Rate" value={data ? fmtPercent(data.win_rate) : undefined} change={previous ? pointChange(data?.win_rate, previous.win_rate, VERSUS) : null} changeNote="vs previous period" sub={noDeals ?? (won && data?.deals_lost ? `${won.count} won · ${data.deals_lost.count} lost` : label)} href="/pipeline?tab=analytics" />
          </section>

          <section aria-label="Pipeline and leads" className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1.25fr)_minmax(0,1fr)]">
            <Panel
              title="Sales Pipeline (Deals)"
              action={
                pipelineList.length > 1 ? (
                  <Select value={pipeline ?? ALL_PIPELINES} onValueChange={(v) => setParam("pipeline", v === ALL_PIPELINES ? undefined : v)}>
                    <SelectTrigger className="h-8 w-36 text-xs" aria-label="Pipeline">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_PIPELINES}>Default pipeline</SelectItem>
                      {pipelineList.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : undefined
              }
            >
              {!data ? <Skeleton className="h-56 w-full" /> : <StageBars data={data} currency={currency} />}
            </Panel>
            <Panel title="Leads by Status">{!data ? <Skeleton className="h-40 w-full" /> : <LeadsDonut data={data} />}</Panel>
            <div className="grid lg:col-span-2 xl:col-span-1">
              <QuickActionsList active={active} />
            </div>
          </section>

          <section aria-label="Today's work" className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <TodaysFollowUps enabled={canActivities} active={active} />
            <PendingTasks enabled={canActivities} active={active} mine={mine} total={data?.activities?.tasks_open} />
            <div className="grid lg:col-span-2 xl:col-span-1">
              <RecentActivities enabled={canActivities} mine={mine} />
            </div>
          </section>

          <details className="group">
            <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 text-sm font-semibold text-fg-muted hover:text-fg">
              <BarChart3 className="size-4" aria-hidden /> More insights
            </summary>
            <div className="mt-3 grid gap-4">
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
              <section aria-label="Upcoming work and suggestions" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {data ? <UpcomingOverdue data={data} /> : <Skeleton className="h-32 w-full" />}
                <AiInsightsCard data={data} currency={currency} />
                <QuickActionsGrid active={active} />
              </section>
              <section aria-label="Sales summary" className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
                <StatTile label="Weighted pipeline" value={data ? (data.weighted_pipeline ? formatMoney(data.weighted_pipeline.amount, currency) : "—") : undefined} sub={data?.weighted_pipeline ? "Value × probability" : undefined} hint="Right now" href="/dashboard/forecast" />
                <StatTile label="Deals won" value={data ? fmtCount(won?.count) : undefined} hint={label} href={wonHref} />
                <StatTile label="Deals lost" value={data ? fmtCount(data.deals_lost?.count) : undefined} sub={data?.deals_lost ? formatMoney(data.deals_lost.amount, currency) : undefined} hint={label} href={lostHref} />
                <StatTile label="Won revenue" value={data ? (won ? formatMoney(won.amount, currency) : "—") : undefined} hint={label} subTone="success" href={wonHref} />
                <StatTile label="Total deals" value={data ? fmtCount(data.totals?.deals?.count) : undefined} hint="All deals" href={`/pipeline?closed_period=all${ownerQs}${pipelineQs}`} />
                <StatTile label="Companies" icon={<Building2 />} value={data ? fmtCount(data.totals?.companies?.count) : undefined} hint="All companies" href="/companies" />
              </section>
              <section aria-label="Activity summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
                <StatTile size="sm" label="Tasks due" icon={<ListTodo />} value={data ? fmtCount(data.activities?.tasks_due) : undefined} sub={data?.activities ? (data.activities.tasks_overdue > 0 ? `${data.activities.tasks_overdue.toLocaleString()} overdue` : "Nothing overdue") : undefined} subTone={data?.activities && data.activities.tasks_overdue > 0 ? "danger" : "default"} hint={noActivities ?? "Open tasks"} href="/activities?tab=tasks&due=today" />
                <StatTile size="sm" label="Meetings" icon={<CalendarDays />} value={data ? fmtCount(data.activities?.meetings_upcoming) : undefined} sub={data?.activities ? "Upcoming this week" : undefined} hint={noActivities} href="/activities?tab=calendar" />
                <StatTile size="sm" label="Calls" icon={<Phone />} value={data ? fmtCount(data.activities?.calls_completed) : undefined} sub={data?.activities ? `${data.activities.calls_upcoming.toLocaleString()} upcoming` : undefined} hint={noActivities} href="/activities?tab=calls" />
                <StatTile size="sm" label="Lead conversion" icon={<UserPlus />} value={data ? (lead ? fmtPercent(lead.rate) : "—") : undefined} sub={lead ? `${lead.converted.toLocaleString()} converted / ${lead.created.toLocaleString()} created` : undefined} hint={label} href="/contacts" />
                <StatTile size="sm" label="Average deal size" icon={<Scale />} value={data ? (data.average_deal_size !== null ? formatMoney(data.average_deal_size, currency) : "—") : undefined} hint={`Won deals · ${label.toLowerCase()}`} href={wonHref} />
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
