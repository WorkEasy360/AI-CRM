"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { DashboardTabs } from "@/components/dashboard/dashboard-tabs";
import { Panel, StatTile } from "@/components/dashboard/stat-tile";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getForecast, listPipelines } from "@/lib/api/crm";
import type { ForecastGroupBy, ForecastPeriod } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { useListParams } from "@/lib/crm/use-list-params";
import { usePermission, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ForecastBreakdown, GROUP_LABELS } from "./forecast-breakdown";
import { ForecastSeriesChart } from "./forecast-chart";

const PERIODS: { value: ForecastPeriod; label: string }[] = [
  { value: "month", label: "This month" },
  { value: "quarter", label: "This quarter" },
  { value: "custom", label: "Custom" },
];
const GROUPS: ForecastGroupBy[] = ["stage", "owner", "team", "pipeline"];
const ALL_PIPELINES = "__all__";

function periodOf(value: string | undefined): ForecastPeriod {
  return PERIODS.some((p) => p.value === value) ? (value as ForecastPeriod) : "month";
}

function groupOf(value: string | undefined): ForecastGroupBy {
  return (GROUPS as readonly string[]).includes(value ?? "") ? (value as ForecastGroupBy) : "stage";
}

function fmtDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

/**
 * Deterministic revenue forecast: open deals by expected close date, weighted by their probability.
 * Arithmetic on today's pipeline, not a prediction, and the page says so.
 */
export function ForecastPage() {
  const session = useSession();
  const currency = session.data?.active?.organization.base_currency ?? "USD";
  const canView = usePermission("reports.view");
  const { params, setParam, setParams } = useListParams(["period", "from", "to", "pipeline", "group_by"]);
  const period = periodOf(params.period);
  const groupBy = groupOf(params.group_by);
  const pipeline = params.pipeline;
  const custom = period === "custom";
  const ready = !custom || Boolean(params.from && params.to);

  const query = { period, from: custom ? params.from : undefined, to: custom ? params.to : undefined, pipeline, group_by: groupBy };
  const forecast = useQuery({
    queryKey: crmKeys.forecast(query),
    queryFn: () => getForecast(query),
    enabled: ready && canView !== null,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), staleTime: 5 * 60_000, enabled: canView !== null });
  const pipelineList = pipelines.data?.results ?? [];
  const data = forecast.data;
  const totals = data?.totals;
  const deals = (n: number) => `${n.toLocaleString()} ${n === 1 ? "deal" : "deals"}`;

  const rangeLabel = data ? `${fmtDate(data.from)} – ${fmtDate(data.to)}` : undefined;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Forecast" description={rangeLabel ? `${rangeLabel}${data?.pipeline ? ` · ${data.pipeline.name}` : ""}` : "Open deals by expected close date, weighted by probability"} actions={<DashboardTabs active="forecast" />} />

      {session.isSuccess && session.data.active && canView === null ? (
        <EmptyState icon={<Lock />} title="Forecast is not available for your role" description="Ask an administrator for the Reports permission to see weighted revenue by period." />
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Forecast filters">
            <Select value={period} onValueChange={(v) => setParams({ period: v === "month" ? undefined : v, ...(v === "custom" ? {} : { from: undefined, to: undefined }) })}>
              <SelectTrigger className="h-8 w-36" aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {custom ? (
              <>
                <Input type="date" aria-label="From" className="h-8 w-36" value={params.from ?? ""} max={params.to} onChange={(e) => setParam("from", e.target.value || undefined)} />
                <span className="text-xs text-fg-subtle" aria-hidden>
                  to
                </span>
                <Input type="date" aria-label="To" className="h-8 w-36" value={params.to ?? ""} min={params.from} onChange={(e) => setParam("to", e.target.value || undefined)} />
              </>
            ) : null}
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
            <Select value={groupBy} onValueChange={(v) => setParam("group_by", v === "stage" ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label="Group by">
                <span className="text-fg-subtle">By&nbsp;</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUPS.map((g) => (
                  <SelectItem key={g} value={g}>
                    {GROUP_LABELS[g]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="basis-full text-xs text-fg-muted sm:ml-auto sm:basis-auto">
              Weighted = value × probability. Arithmetic on today&apos;s pipeline, not a prediction.
            </p>
          </div>

          {!ready ? (
            <EmptyState title="Choose a date range" description="Pick a start and end date to forecast a custom period." />
          ) : forecast.isError ? (
            <EmptyState title="Could not load the forecast" description={errorMessage(forecast.error)} action={<Button variant="secondary" onClick={() => forecast.refetch()}>Retry</Button>} />
          ) : (
            <div className={cn("grid gap-3", forecast.isFetching && "opacity-80")} aria-busy={forecast.isFetching || undefined}>
              <section aria-label="Forecast totals" className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                <StatTile label="Pipeline value" value={totals ? formatMoney(totals.pipeline.amount, currency) : undefined} sub={totals ? `${deals(totals.pipeline.count)} closing in period` : undefined} href={`/pipeline?view=list&sort=expected_close_date${pipeline ? `&pipeline=${encodeURIComponent(pipeline)}` : ""}`} />
                <StatTile label="Weighted" emphasis value={totals ? formatMoney(totals.weighted.amount, currency) : undefined} sub="Value × probability" />
                <StatTile label="Committed" value={totals ? formatMoney(totals.committed.amount, currency) : undefined} sub={data ? `${deals(totals!.committed.count)} at ≥ ${data.committed_probability}% probability` : undefined} />
                <StatTile label="Won so far" value={totals ? formatMoney(totals.won.amount, currency) : undefined} sub={totals ? deals(totals.won.count) : undefined} subTone="success" href={`/pipeline?view=list&status=won${pipeline ? `&pipeline=${encodeURIComponent(pipeline)}` : ""}`} />
                <StatTile label="Expected revenue" value={totals ? formatMoney(totals.expected_revenue, currency) : undefined} sub="Weighted + won" />
              </section>

              {data ? (
                <p className="text-xs text-fg-muted">
                  Based on <span className="font-medium text-fg">{data.coverage.in_period.toLocaleString()}</span> open {data.coverage.in_period === 1 ? "deal" : "deals"} closing in the period ·{" "}
                  <span className={cn(data.coverage.without_close_date > 0 && "font-medium text-fg")}>{data.coverage.without_close_date.toLocaleString()}</span> open {data.coverage.without_close_date === 1 ? "deal has" : "deals have"} no close date ·{" "}
                  <span className={cn(data.coverage.overdue > 0 && "font-medium text-danger")}>{data.coverage.overdue.toLocaleString()}</span> overdue ·{" "}
                  <Link href="/pipeline?view=list&sort=expected_close_date" className="font-medium text-primary hover:underline">
                    Review close dates
                  </Link>
                </p>
              ) : (
                <Skeleton className="h-4 w-2/3" />
              )}

              <Panel title="By month" subtitle="Pipeline, weighted and won for each month in the period">
                {!data ? <Skeleton className="h-44 w-full" /> : <ForecastSeriesChart series={data.series} currency={currency} />}
              </Panel>

              <Panel title={`By ${GROUP_LABELS[groupBy].toLowerCase()}`} subtitle="Open deals closing in the period plus what is already won">
                {!data ? <Skeleton className="h-40 w-full" /> : <ForecastBreakdown forecast={data} currency={currency} pipeline={pipeline} />}
              </Panel>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
