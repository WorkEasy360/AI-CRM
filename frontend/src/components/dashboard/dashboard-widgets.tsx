"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlarmClock,
  ArrowRight,
  BarChart3,
  Bot,
  BriefcaseBusiness,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Layers,
  ListTodo,
  Mail,
  MessageCircle,
  Phone,
  Sparkles,
  Ticket,
  UserPlus,
  Workflow,
} from "lucide-react";
import { useQuickCreate } from "@/components/shell/quick-create-provider";
import { Avatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { getMyDay, listActivities } from "@/lib/api/crm";
import { DEAL_SOURCE_LABELS, type Activity, type ActivityKind, type DealSource } from "@/lib/api/crm-types";
import type { ActiveContext, DashboardInsight, DashboardSummary } from "@/lib/api/types";
import { formatCompactMoney, formatMoney, stageDotClass, stageTintStyle } from "@/lib/crm/format";
import { hasPermission } from "@/lib/session";
import { cn, formatDateTime } from "@/lib/utils";
import { ChangeBadge, EmptyNote, NoAccess, Panel, PanelLink, monthLabel, percentChange, type KpiChange } from "./stat-tile";

const KIND_ICON: Record<ActivityKind, React.ComponentType<{ className?: string }>> = { task: CheckCircle2, call: Phone, meeting: CalendarDays };
const KIND_TINT: Record<ActivityKind, string> = { task: "bg-[#dcfce7] text-[#15803d]", call: "bg-[#dcfce7] text-[#15803d]", meeting: "bg-[#f3e8ff] text-[#7e22ce]" };

function relatedName(a: Activity): string {
  return a.company?.name || a.deal?.name || a.contact?.name || "";
}

function timeOf(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

/* ------------------------------------------------------------------ pipeline overview */

/** The stages as coloured tiles: count and value, each opening the pipeline filtered to that stage. */
export function PipelineOverview({ data, currency }: { data: DashboardSummary; currency: string }) {
  if (data.deals_by_stage === null) return <NoAccess />;
  const stages = (data.deals_by_stage?.stages ?? []).filter((s) => s.kind !== "lost");
  if (stages.length === 0) return <EmptyNote>No pipeline stages yet.</EmptyNote>;
  const pipelineId = data.deals_by_stage?.pipeline?.id;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {stages.map((s) => (
        <li key={s.id}>
          <Link
            href={`/pipeline?view=list&stage=${encodeURIComponent(s.id)}${pipelineId ? `&pipeline=${encodeURIComponent(pipelineId)}` : ""}`}
            className="block rounded-lg px-3 py-3 transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring"
            style={stageTintStyle(s.color_token)}
          >
            <span className="flex items-center gap-1.5 truncate text-sm font-semibold text-fg">
              <span className={cn("size-2 shrink-0 rounded-full", stageDotClass(s.color_token))} aria-hidden />
              {s.name}
            </span>
            <span className="mt-1.5 block text-2xl font-bold tabular-nums text-fg">{s.count.toLocaleString()}</span>
            <span className="block truncate text-xs font-medium tabular-nums text-fg-muted">{formatMoney(s.amount, currency)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ revenue trend */

/** Won revenue per month: bars with a line over the same values (one axis), total and growth above. */
export function RevenueBars({ data, currency }: { data: DashboardSummary; currency: string }) {
  const trend = data.revenue_trend;
  if (trend === null) return <NoAccess />;
  if (trend.length === 0) return <EmptyNote>No won deals yet.</EmptyNote>;
  const values = trend.map((t) => Number(t.amount || 0));
  const total = values.reduce((a, b) => a + b, 0);
  const growth = percentChange(values.at(-1), values.at(-2), "compared with the month before");
  const max = Math.max(...values, 0);
  const width = 320;
  const height = 150;
  const left = 34;
  const bottom = 20;
  const top = 10;
  const plot = height - top - bottom;
  const slot = (width - left) / trend.length;
  const barW = Math.min(26, slot * 0.55);
  const y = (v: number) => height - bottom - (max > 0 ? (v / max) * plot : 0);
  const x = (i: number) => left + slot * i + slot / 2;
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-end gap-x-2 text-right">
        <span className="text-xl font-bold tabular-nums text-fg">{formatMoney(total, currency)}</span>
        {growth ? <ChangeBadge change={growth} /> : null}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full overflow-visible" role="img" aria-label={`Won revenue by month, ${formatMoney(total, currency)} in total`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={left} x2={width} y1={height - bottom - plot * f + 0.5} y2={height - bottom - plot * f + 0.5} className="stroke-border" strokeDasharray={f === 0 ? undefined : "3 3"} strokeWidth={1} />
            <text x={left - 4} y={height - bottom - plot * f + 3} textAnchor="end" className="fill-fg-subtle text-[10px]">
              {formatCompactMoney(max * f, currency)}
            </text>
          </g>
        ))}
        {trend.map((t, i) => (
          <g key={t.month}>
            <title>{`${monthLabel(t.month, true)}: ${formatMoney(t.amount, currency)} from ${t.count} won ${t.count === 1 ? "deal" : "deals"}`}</title>
            <rect x={x(i) - barW / 2} y={y(values[i] ?? 0)} width={barW} height={Math.max(0, height - bottom - y(values[i] ?? 0))} rx={4} className="fill-[#bbf7d0]" />
            <rect x={x(i) - slot / 2} y={top} width={slot} height={plot} fill="transparent" />
            <text x={x(i)} y={height - 5} textAnchor="middle" className="fill-fg-subtle text-[11px]">
              {monthLabel(t.month)}
            </text>
          </g>
        ))}
        <path d={line} fill="none" stroke="var(--kl-brand)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {values.map((v, i) => (
          <circle key={trend[i]!.month} cx={x(i)} cy={y(v)} r={4} fill="var(--kl-surface)" stroke="var(--kl-brand)" strokeWidth={2} />
        ))}
      </svg>
      <table className="sr-only">
        <caption>Won revenue by month</caption>
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

/* ------------------------------------------------------------------ deals by source */

/** Fixed per source (never by rank), so filtering never repaints a source. Validated as a set. */
const SOURCE_HUES: Record<string, string> = { whatsapp: "#16a34a", facebook_ads: "#3b82f6", website: "#d97706", referral: "#8b5cf6", other: "#94a3b0", "": "#cbd5e1" };
const SOURCE_ORDER = ["whatsapp", "facebook_ads", "website", "referral", "other", ""];

export function SourceDonut({ data }: { data: DashboardSummary }) {
  if (data.deals_by_source === null || data.deals_by_source === undefined) return <NoAccess />;
  const counts = new Map(data.deals_by_source.map((r) => [r.source, r.count]));
  const slices = SOURCE_ORDER.filter((key) => key !== "" || (counts.get("") ?? 0) > 0).map((key) => ({
    key,
    label: key === "" ? "Not set" : DEAL_SOURCE_LABELS[key as DealSource],
    count: counts.get(key) ?? 0,
    color: SOURCE_HUES[key]!,
  }));
  const total = slices.reduce((sum, s) => sum + s.count, 0);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const gap = slices.filter((s) => s.count > 0).length > 1 ? 2 : 0;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" className="size-32 shrink-0 -rotate-90" role="img" aria-label={`Deals by source: ${total} in total`}>
        <circle cx={60} cy={60} r={radius} fill="none" strokeWidth={18} className="stroke-bg-subtle" />
        {total > 0
          ? slices.map((s) => {
              if (s.count === 0) return null;
              const length = (s.count / total) * circumference;
              const dash = Math.max(0, length - gap);
              const el = (
                <circle key={s.key || "none"} cx={60} cy={60} r={radius} fill="none" stroke={s.color} strokeWidth={18} strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset}>
                  <title>{`${s.label}: ${s.count}`}</title>
                </circle>
              );
              offset += length;
              return el;
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
      <ul className="grid min-w-0 flex-1 gap-1.5 text-xs">
        {slices.map((s) => (
          <li key={s.key || "none"} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
            <span className="truncate text-fg">{s.label}</span>
            <span className="ml-auto tabular-nums text-fg-muted">
              {s.count.toLocaleString()} ({total ? Math.round((100 * s.count) / total) : 0}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ team */

export function TopTeam({ data, currency }: { data: DashboardSummary; currency: string }) {
  const team = data.top_team;
  if (team === null || team === undefined) return <NoAccess />;
  if (team.length === 0) return <EmptyNote>No deals won in this period yet.</EmptyNote>;
  const max = Math.max(...team.map((m) => m.count), 1);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-fg-muted">
          <th className="pb-1.5 font-medium">Team Member</th>
          <th className="pb-1.5 font-medium">Deals</th>
          <th className="pb-1.5 text-right font-medium">Revenue</th>
        </tr>
      </thead>
      <tbody>
        {team.map((m) => (
          <tr key={m.id} className="border-t border-border">
            <td className="py-1.5 pr-2">
              <span className="flex items-center gap-2">
                <Avatar name={m.name} size="sm" />
                <span className="truncate">{m.name}</span>
              </span>
            </td>
            <td className="w-1/3 py-1.5 pr-2">
              <span className="block tabular-nums">{m.count}</span>
              <span className="mt-0.5 block h-1.5 rounded-full bg-bg-subtle" aria-hidden>
                <span className="block h-1.5 rounded-full bg-brand" style={{ width: `${Math.round((m.count / max) * 100)}%` }} />
              </span>
            </td>
            <td className="py-1.5 text-right tabular-nums">{formatMoney(m.amount, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ business summary */

export function BusinessSummary({ data }: { data: DashboardSummary }) {
  const a = data.activities;
  const t = data.tickets;
  const versus = "compared with the previous period";
  const rows: { label: string; icon: React.ComponentType<{ className?: string }>; tint: string; value: number | null | undefined; change: KpiChange | null; href: string }[] = [
    { label: "Total Activities", icon: CalendarCheck, tint: "text-[#15803d]", value: a?.logged, change: a ? percentChange(a.logged, a.prev_logged, versus) : null, href: "/activities" },
    { label: "Tasks", icon: ListTodo, tint: "text-[#15803d]", value: a?.logged_tasks, change: a ? percentChange(a.logged_tasks, a.prev_logged_tasks, versus) : null, href: "/activities?tab=tasks" },
    { label: "Calls", icon: Phone, tint: "text-[#c2410c]", value: a?.logged_calls, change: a ? percentChange(a.logged_calls, a.prev_logged_calls, versus) : null, href: "/activities?tab=calls" },
    { label: "Meetings", icon: CalendarDays, tint: "text-[#7e22ce]", value: a?.logged_meetings, change: a ? percentChange(a.logged_meetings, a.prev_logged_meetings, versus) : null, href: "/activities?tab=meetings" },
  ];
  if (t !== null && t !== undefined) {
    const change = percentChange(t.created, t.created_previous, "new tickets compared with the previous period");
    rows.push({ label: "Open Tickets", icon: Ticket, tint: "text-[#b91c1c]", value: t.open, change: change ? { ...change, lowerIsBetter: true } : null, href: "/helpdesk?tab=open" });
  }
  if (!a && !t) return <NoAccess />;
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map((row) => (
        <li key={row.label}>
          <Link href={row.href} className="flex items-center gap-2.5 py-1.5 text-sm hover:text-primary">
            <row.icon className={cn("size-4 shrink-0", row.tint)} aria-hidden />
            <span className="flex-1 truncate">{row.label}</span>
            <span className="w-12 text-right font-semibold tabular-nums">{row.value === undefined || row.value === null ? "—" : row.value.toLocaleString()}</span>
            <span className="w-16 text-right">{row.change ? <ChangeBadge change={row.change} /> : null}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ agenda, upcoming, recent */

/** Today's timed activities for the signed-in member, as a timeline. */
export function TodayAgenda({ enabled }: { enabled: boolean }) {
  const day = useQuery({ queryKey: ["crm", "activities", "my-day", "dashboard"], queryFn: () => getMyDay(Intl.DateTimeFormat().resolvedOptions().timeZone), enabled, staleTime: 30_000 });
  const items = React.useMemo(() => {
    if (!day.data) return [];
    return [...day.data.events, ...day.data.calls, ...day.data.tasks].filter((a) => a.start_at).sort((x, y) => (x.start_at ?? "").localeCompare(y.start_at ?? ""));
  }, [day.data]);
  return (
    <Panel title={`Today's Agenda${day.data ? ` (${items.length})` : ""}`} action={<PanelLink href="/activities?tab=day">View all</PanelLink>}>
      {!enabled ? (
        <NoAccess />
      ) : day.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : day.isError ? (
        <EmptyNote>Your agenda is unavailable right now.</EmptyNote>
      ) : items.length === 0 ? (
        <EmptyNote>Nothing scheduled for today.</EmptyNote>
      ) : (
        <ol className="relative flex flex-col gap-2 pl-4 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border">
          {items.slice(0, 5).map((a) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <li key={a.id} className="relative flex items-center gap-2">
                <span className="absolute -left-4 top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-brand bg-surface" aria-hidden />
                <span className="w-16 shrink-0 text-xs font-medium tabular-nums text-fg">{timeOf(a.start_at)}</span>
                <Link href={`/activities?open=${encodeURIComponent(a.id)}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-2 py-1.5 hover:bg-bg-subtle">
                  <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", KIND_TINT[a.kind])} aria-hidden>
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-fg">{a.title}</span>
                    {relatedName(a) ? <span className="block truncate text-xs text-fg-muted">{relatedName(a)}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

export function UpcomingOverdue({ data }: { data: DashboardSummary }) {
  const a = data.activities;
  const rows = [
    a ? { label: `${a.overdue ?? a.tasks_overdue} Overdue Activities`, icon: AlarmClock, tint: "text-danger", href: "/activities?due=overdue" } : null,
    a ? { label: `${a.due_week ?? 0} Activities Due This Week`, icon: CalendarDays, tint: "text-[#1d4ed8]", href: "/activities?due=week" } : null,
    data.deals_closing_week !== null && data.deals_closing_week !== undefined
      ? { label: `${data.deals_closing_week} Deals Closing This Week`, icon: BriefcaseBusiness, tint: "text-fg-muted", href: "/pipeline?view=list&status=open&sort=expected_close_date" }
      : null,
  ].filter(Boolean) as { label: string; icon: React.ComponentType<{ className?: string }>; tint: string; href: string }[];
  return (
    <Panel title="Upcoming & Overdue" action={<PanelLink href="/activities">View all</PanelLink>}>
      {rows.length === 0 ? (
        <NoAccess />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <li key={row.label}>
              <Link href={row.href} className="flex items-center gap-2.5 py-2 text-sm hover:text-primary">
                <row.icon className={cn("size-4 shrink-0", row.tint)} aria-hidden />
                <span className="flex-1">{row.label}</span>
                <ChevronRight className="size-4 text-fg-subtle" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function RecentActivities({ enabled }: { enabled: boolean }) {
  const recent = useQuery({ queryKey: ["crm", "activities", "recent", "dashboard"], queryFn: () => listActivities({ sort: "-updated_at", limit: "4" }), enabled, staleTime: 30_000 });
  return (
    <Panel title="Recent Activities" action={<PanelLink href="/activities">View all</PanelLink>}>
      {!enabled ? (
        <NoAccess />
      ) : recent.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : recent.isError ? (
        <EmptyNote>Recent activities are unavailable right now.</EmptyNote>
      ) : recent.data.results.length === 0 ? (
        <EmptyNote>No activities yet.</EmptyNote>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {recent.data.results.map((a) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <li key={a.id}>
                <Link href={`/activities?open=${encodeURIComponent(a.id)}`} className="flex items-center gap-2.5 py-1.5 text-sm hover:text-primary">
                  <Icon className="size-4 shrink-0 text-[#15803d]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {a.title}
                    {relatedName(a) ? <span className="text-fg-muted"> – {relatedName(a)}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-fg-muted">{a.start_at ? formatDateTime(a.start_at) : "No date"}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ quick actions */

type QuickAction = { label: string; icon: React.ComponentType<{ className?: string }>; tint: string; permission: string } & ({ create: "contact" | "deal" | "task" | "meeting" } | { href: string });

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Add Contact", icon: UserPlus, tint: "text-[#15803d]", permission: "contacts.create", create: "contact" },
  { label: "Add Deal", icon: Layers, tint: "text-[#7e22ce]", permission: "deals.create", create: "deal" },
  { label: "Add Task", icon: CheckCircle2, tint: "text-[#15803d]", permission: "activities.create", create: "task" },
  { label: "Schedule Meeting", icon: CalendarDays, tint: "text-[#7e22ce]", permission: "activities.create", create: "meeting" },
  { label: "Send WhatsApp", icon: MessageCircle, tint: "text-[#15803d]", permission: "whatsapp.view", href: "/activities?tab=whatsapp" },
  { label: "Send Email", icon: Mail, tint: "text-[#15803d]", permission: "email.view", href: "/activities?tab=emails" },
  { label: "Create Automation", icon: Workflow, tint: "text-[#15803d]", permission: "automation.view", href: "/settings/automation" },
  { label: "View Reports", icon: BarChart3, tint: "text-[#15803d]", permission: "deals.view", href: "/pipeline?tab=analytics" },
];

export function QuickActionsGrid({ active }: { active: ActiveContext | null | undefined }) {
  const { open } = useQuickCreate();
  const items = QUICK_ACTIONS.filter((a) => hasPermission(active, a.permission));
  const tile = "flex h-[4.5rem] flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface px-1 text-center text-xs font-medium text-fg shadow-sm transition-colors hover:border-brand hover:bg-[#f0fdf4]";
  return (
    <Panel title="Quick Actions">
      {items.length === 0 ? (
        <NoAccess />
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {items.map((a) => (
            <li key={a.label}>
              {"create" in a ? (
                <button type="button" className={cn(tile, "w-full")} onClick={() => open(a.create)}>
                  <a.icon className={cn("size-5", a.tint)} aria-hidden />
                  {a.label}
                </button>
              ) : (
                <Link href={a.href} className={tile}>
                  <a.icon className={cn("size-5", a.tint)} aria-hidden />
                  {a.label}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ AI insights */

/** The card's sentences, worded here from the server's counts, each linking to the list it summarises. */
export function insightText(insight: DashboardInsight, currency: string): { text: string; href: string } {
  switch (insight.key) {
    case "follow_ups_today":
      return { text: `${insight.count} ${insight.count === 1 ? "follow-up is" : "follow-ups are"} due today.`, href: "/activities?due=today" };
    case "deals_close_to_winning":
      return { text: `${insight.count} high-value ${insight.count === 1 ? "deal is" : "deals are"} close to winning (${formatMoney(insight.amount, currency)}).`, href: "/pipeline?view=list&status=open&probability_min=60" };
    case "win_rate_change":
      return { text: `Your win rate ${insight.points > 0 ? "improved" : "dropped"} by ${Math.abs(insight.points)} points this period.`, href: "/pipeline?tab=analytics" };
    case "deals_without_next_step":
      return { text: `Schedule next steps for ${insight.count} open ${insight.count === 1 ? "deal" : "deals"} with nothing planned.`, href: "/pipeline" };
    case "tickets_overdue":
      return { text: `${insight.count} support ${insight.count === 1 ? "ticket is" : "tickets are"} past their SLA.`, href: "/helpdesk?tab=overdue" };
  }
}

export function AiInsightsCard({ data, currency }: { data: DashboardSummary | undefined; currency: string }) {
  const insights = data?.insights ?? [];
  return (
    <section aria-label="WorkEasy AI Insights" className="rounded-lg border border-[#e9d5ff] bg-gradient-to-br from-[#faf5ff] to-[#f3e8ff] p-4 shadow-sm dark:from-transparent dark:to-transparent">
      <h2 className="flex items-center gap-2 text-base font-bold text-[#6b21a8] dark:text-[#d8b4fe]">
        <Bot className="size-5" aria-hidden /> WorkEasy AI Insights <Sparkles className="size-4 text-[#d97706]" aria-hidden />
      </h2>
      {!data ? (
        <Skeleton className="mt-3 h-24 w-full" />
      ) : insights.length === 0 ? (
        <p className="mt-3 text-sm text-fg-muted">All caught up: nothing needs your attention right now.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2 rounded-md bg-surface/80 p-3">
          {insights.map((insight) => {
            const { text, href } = insightText(insight, currency);
            return (
              <li key={insight.key}>
                <Link href={href} className="flex items-start gap-2 text-sm text-fg hover:text-primary">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {text}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link href="/assistant" className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md bg-brand px-4 text-sm font-semibold text-brand-fg hover:bg-brand-hover">
        Ask WorkEasy AI <ArrowRight className="size-4" aria-hidden />
      </Link>
    </section>
  );
}

