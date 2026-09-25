"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ListTodo, Phone, Scale, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listPipelines } from "@/lib/api/crm";
import { getDashboard } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import { DASHBOARD_PERIODS, type DashboardPeriod } from "@/lib/api/types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { useListParams } from "@/lib/crm/use-list-params";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { DashboardTabs } from "./dashboard-tabs";
import { Panel, PanelLink, StatTile, fmtCount, fmtPercent } from "./stat-tile";

import dynamic from "next/dynamic";

// The numbers are the dashboard; the assistant and the charts are what you read next. Both load as
// their own chunks so the stat tiles paint without waiting for the assistant's answer view or the
// chart code, and a member who never opens the dashboard's lower half never downloads either.
const AskKeelCard = dynamic(() => import("@/components/assistant/ask-keel").then((m) => m.AskKeelCard), { ssr: false });
const DealsByOwner = dynamic(() => import("./charts").then((m) => m.DealsByOwner), { ssr: false });
const DealsByStage = dynamic(() => import("./charts").then((m) => m.DealsByStage), { ssr: false });
const ForecastBars = dynamic(() => import("./charts").then((m) => m.ForecastBars), { ssr: false });
const RevenueTrend = dynamic(() => import("./charts").then((m) => m.RevenueTrend), { ssr: false });
const TopCompanies = dynamic(() => import("./charts").then((m) => m.TopCompanies), { ssr: false });

const PERIOD_LABELS: Record<DashboardPeriod, string> = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", "365d": "Last 12 months" };
const ALL_PIPELINES = "__all__";

function periodOf(value: string | undefined): DashboardPeriod {
  return (DASHBOARD_PERIODS as readonly string[]).includes(value ?? "") ? (value as DashboardPeriod) : "30d";
}

/** Sales numbers only: everything here is scoped to what the member may see, nothing technical. */
export function DashboardPage() {
  const { data: session } = useSession();
  const currency = session?.active?.organization.base_currency ?? "USD";
  const { params, setParam } = useListParams(["period", "pipeline"]);
  const period = periodOf(params.period);
  const pipeline = params.pipeline;

  const summary = useQuery({
    queryKey: queryKeys.dashboard(period, pipeline),
    queryFn: () => getDashboard(period, pipeline),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), staleTime: 5 * 60_000 });
  const pipelineList = pipelines.data?.results ?? [];
  const data = summary.data;
  const periodLabel = PERIOD_LABELS[period];
  const pipelineQs = pipeline ? `&pipeline=${encodeURIComponent(pipeline)}` : "";
  const noActivities = data && !data.activities ? "Your role does not include Activities" : undefined;
  const lead = data?.lead_conversion;
  const won = data?.deals_won;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Dashboard"
        actions={
          <>
            <DashboardTabs active="overview" />
            {pipelineList.length > 1 ? (
              <Select value={pipeline ?? ALL_PIPELINES} onValueChange={(v) => setParam("pipeline", v === ALL_PIPELINES ? undefined : v)}>
                <SelectTrigger className="h-8 w-40" aria-label="Pipeline">
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
            <Select value={period} onValueChange={(v) => setParam("period", v === "30d" ? undefined : v)}>
              <SelectTrigger className="h-8 w-36" aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
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
        <div className={cn("grid gap-3", summary.isFetching && "opacity-80")} aria-busy={summary.isFetching || undefined}>
          <section aria-label="Sales summary" className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
            <StatTile
              label="Pipeline value"
              value={data ? (data.open_pipeline ? formatMoney(data.open_pipeline.amount, currency) : "—") : undefined}
              sub={data?.open_pipeline ? `${data.open_pipeline.count} open ${data.open_pipeline.count === 1 ? "deal" : "deals"}` : undefined}
              hint="Right now"
              href={`/pipeline${pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : ""}`}
            />
            <StatTile
              label="Weighted pipeline"
              value={data ? (data.weighted_pipeline ? formatMoney(data.weighted_pipeline.amount, currency) : "—") : undefined}
              sub={data?.weighted_pipeline ? "Value × probability" : undefined}
              hint="Right now"
              href="/dashboard/forecast"
            />
            <StatTile label="Won revenue" value={data ? (won ? formatMoney(won.amount, currency) : "—") : undefined} hint={periodLabel} subTone="success" href={`/pipeline?view=list&status=won${pipelineQs}`} />
            <StatTile
              label="Deals won"
              value={data ? fmtCount(won?.count) : undefined}
              sub={data && won && data.win_rate !== null ? `${fmtPercent(data.win_rate)} win rate` : undefined}
              hint={periodLabel}
              href={`/pipeline?view=list&status=won${pipelineQs}`}
            />
            <StatTile
              label="Deals lost"
              value={data ? fmtCount(data.deals_lost?.count) : undefined}
              sub={data?.deals_lost ? formatMoney(data.deals_lost.amount, currency) : undefined}
              hint={periodLabel}
              href={`/pipeline?view=list&status=lost${pipelineQs}`}
            />
          </section>

          <section aria-label="Activity summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <StatTile
              size="sm"
              label="Tasks due"
              icon={<ListTodo />}
              value={data ? fmtCount(data.activities?.tasks_due) : undefined}
              sub={data?.activities ? (data.activities.tasks_overdue > 0 ? `${data.activities.tasks_overdue.toLocaleString()} overdue` : "Nothing overdue") : undefined}
              subTone={data?.activities && data.activities.tasks_overdue > 0 ? "danger" : "default"}
              hint={noActivities ?? "Open tasks"}
              href="/activities?tab=tasks&due=today"
            />
            <StatTile
              size="sm"
              label="Meetings"
              icon={<CalendarDays />}
              value={data ? fmtCount(data.activities?.meetings_upcoming) : undefined}
              sub={data?.activities ? "Upcoming this week" : undefined}
              hint={noActivities}
              href="/activities?tab=calendar"
            />
            <StatTile
              size="sm"
              label="Calls"
              icon={<Phone />}
              value={data ? fmtCount(data.activities?.calls_completed) : undefined}
              sub={data?.activities ? `${data.activities.calls_upcoming.toLocaleString()} upcoming · ${periodLabel.toLowerCase()}` : undefined}
              hint={noActivities}
              href="/activities?tab=calls"
            />
            <StatTile
              size="sm"
              label="Lead conversion"
              icon={<UserPlus />}
              value={data ? (lead ? fmtPercent(lead.rate) : "—") : undefined}
              sub={lead ? `${lead.converted.toLocaleString()} converted / ${lead.created.toLocaleString()} created` : undefined}
              hint={periodLabel}
              href="/contacts"
            />
            <StatTile
              size="sm"
              label="Average deal size"
              icon={<Scale />}
              value={data ? (data.average_deal_size !== null ? formatMoney(data.average_deal_size, currency) : "—") : undefined}
              hint={`Won deals · ${periodLabel.toLowerCase()}`}
              href={`/pipeline?view=list&status=won${pipelineQs}`}
            />
          </section>

          {/* Between the numbers and the charts: close enough to the figures to be the obvious next
              question, small enough that the dashboard is still a dashboard. A role without the
              assistant gets no card (and no request that can only answer 403). */}
          {hasPermission(session?.active, "ai.assistant.use") ? <AskKeelCard /> : null}

          <section aria-label="Charts" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Panel title="Deals by stage" subtitle={data?.deals_by_stage?.pipeline?.name ?? "Open deals right now"}>
              {!data ? <Skeleton className="h-40 w-full" /> : <DealsByStage data={data} currency={currency} />}
            </Panel>
            <Panel title="Revenue trend" subtitle="Won deals by month">
              {!data ? <Skeleton className="h-40 w-full" /> : <RevenueTrend data={data} currency={currency} />}
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
      )}
    </div>
  );
}
