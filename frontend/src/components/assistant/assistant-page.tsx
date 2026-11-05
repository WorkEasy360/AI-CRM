"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BarChart3,
  Bot,
  CalendarCheck,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  Clock,
  FileText,
  Filter,
  History,
  IndianRupee,
  Layers,
  Lightbulb,
  LineChart,
  Mail,
  MessageCircle,
  Phone,
  Sparkles,
  TrendingUp,
  Users,
  Wand2,
  Zap,
} from "lucide-react";
import { useInvalidateActivities } from "@/components/activities/activity-utils";
import { relativeTime } from "@/components/activities/activity-utils";
import { insightText } from "@/components/dashboard/dashboard-widgets";
import { ChangeBadge, percentChange } from "@/components/dashboard/stat-tile";
import { useQuickCreate } from "@/components/shell/quick-create-provider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { activitySummary, completeActivity, getMyDay } from "@/lib/api/crm";
import type { Activity } from "@/lib/api/crm-types";
import { getDashboard } from "@/lib/api/endpoints";
import type { DashboardInsight } from "@/lib/api/types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { AskForm, Conversation, useAssistant } from "./ask-keel";

type Icon = React.ComponentType<{ className?: string }>;

interface QuickAction {
  title: string;
  hint?: string;
  icon: Icon;
  /** Icon colour; each is >= 3:1 on white. */
  ink: string;
  /** Asked of the assistant (drafts and analysis), or a real form/page for anything that creates a record. */
  run: { prompt: string } | { create: "task" | "meeting" } | { href: string; permission: string };
}

/** The eight AI Quick Actions of the WorkEasy360 screen, in its order. */
export const ASSISTANT_ACTIONS: readonly QuickAction[] = [
  { title: "Write Message", hint: "(WhatsApp / Email)", icon: Mail, ink: "text-[#15803d]", run: { prompt: "Write a short, friendly WhatsApp follow-up message for my newest lead." } },
  { title: "Create Automation", icon: Filter, ink: "text-[#7e22ce]", run: { href: "/settings/automation", permission: "automation.view" } },
  { title: "Create Task", icon: CheckSquare, ink: "text-[#15803d]", run: { create: "task" } },
  { title: "Schedule Meeting", icon: CalendarDays, ink: "text-[#7e22ce]", run: { create: "meeting" } },
  { title: "Generate Proposal", icon: FileText, ink: "text-[#1d4ed8]", run: { prompt: "Draft a proposal outline for my largest open deal." } },
  { title: "Summarize Lead", icon: FileText, ink: "text-[#1d4ed8]", run: { prompt: "Summarize my newest lead and what I should do next." } },
  { title: "Get Reports", icon: BarChart3, ink: "text-[#15803d]", run: { href: "/pipeline?tab=analytics", permission: "deals.view" } },
];

/** "More Tools": the other starting points, kept from the earlier assistant page. */
const MORE_TOOLS: readonly { title: string; prompt: string }[] = [
  { title: "Create follow-up sequence", prompt: "Suggest a 3-step follow-up sequence for leads that have not replied in a week." },
  { title: "Suggest next action", prompt: "Which deals need attention, and what should I do next on each?" },
  { title: "Create WhatsApp campaign", prompt: "Write a WhatsApp campaign message to re-engage customers who went quiet." },
  { title: "Analyze pipeline", prompt: "Analyze my pipeline and forecast for the next three months." },
  { title: "Automation ideas", prompt: "Suggest automations that would save my sales team time." },
];

/** The four chips under the chat. "Create a task" opens the real task form rather than asking. */
const CHIPS: readonly { label: string; icon: Icon; prompt?: string }[] = [
  { label: "Write a follow-up message", icon: Wand2, prompt: "Write a follow-up message for my most recent lead." },
  { label: "Show deal forecast", icon: LineChart, prompt: "Show my deal forecast for the next three months." },
  { label: "Create a task", icon: CheckSquare },
  { label: "Team performance", icon: BarChart3, prompt: "How is the team performing this month?" },
];

const INSIGHT_ICONS: Record<DashboardInsight["key"], { icon: Icon; ink: string }> = {
  follow_ups_today: { icon: Clock, ink: "text-[#dc2626]" },
  deals_close_to_winning: { icon: Users, ink: "text-[#15803d]" },
  win_rate_change: { icon: TrendingUp, ink: "text-[#15803d]" },
  deals_without_next_step: { icon: Lightbulb, ink: "text-[#ca8a04]" },
  tickets_overdue: { icon: Clock, ink: "text-[#dc2626]" },
};

const KIND_ACTION: Record<Activity["kind"], { label: string; icon: Icon; ink: string }> = {
  call: { label: "Call", icon: Phone, ink: "text-[#15803d]" },
  meeting: { label: "Meeting", icon: CalendarCheck, ink: "text-[#1d4ed8]" },
  task: { label: "WhatsApp", icon: MessageCircle, ink: "text-[#15803d]" },
};

/** The AI Assistant page: the conversation inline, today's summary and follow-ups, quick actions and insights. */
export function AssistantPage() {
  const { data: session } = useSession();
  const assistant = useAssistant();
  const { open } = useQuickCreate();
  const active = session?.active ?? null;
  const allowed = hasPermission(active, "ai.assistant.use");
  const currency = active?.organization.base_currency ?? "USD";
  const name = session?.user.display_name || session?.user.email || "";
  const first = name.split("@")[0]!.trim().split(/\s+/)[0] ?? "";

  // While this page is open the thread is shown here rather than in the side panel.
  const setInline = assistant?.setInline;
  React.useEffect(() => {
    setInline?.(true);
    return () => setInline?.(false);
  }, [setInline]);

  const dashboard = useQuery({ queryKey: queryKeys.dashboard("7d", undefined, 6), queryFn: () => getDashboard("7d"), enabled: allowed && hasPermission(active, "dashboards.view"), staleTime: 60_000 });
  const canActivities = hasPermission(active, "activities.view");

  if (!session) return null;
  if (!allowed || !assistant) {
    return <EmptyState title="AI Assistant is not part of your role" description="Ask a workspace administrator to give your role access to the assistant." />;
  }
  const { submit, busy, knowledgeOnly, turns } = assistant;
  const insights = dashboard.data?.insights ?? [];

  const runAction = (action: QuickAction) => {
    if ("prompt" in action.run) submit(action.run.prompt);
    else if ("create" in action.run) open(action.run.create);
  };

  return (
    <div className="mx-auto max-w-[96rem]">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-chrome text-white shadow-md" aria-hidden>
            <Bot className="size-8" />
          </span>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-fg">
              WorkEasy AI Assistant <span aria-hidden>✨</span>
            </h1>
            <p className="text-sm text-fg-muted">Your intelligent CRM co-pilot for sales, marketing and team productivity.</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#e9d5ff] bg-[#faf5ff] px-3 py-1.5 text-sm font-semibold text-[#6b21a8]">
          <Sparkles className="size-4" aria-hidden /> {knowledgeOnly ? "Knowledge search mode" : "Powered by AI"}
        </span>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <section aria-label="Conversation" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <div className="flex items-start gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-chrome text-white" aria-hidden>
              <Bot className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <TodayCard first={first} currency={currency} canActivities={canActivities} />
              {insights[0] ? (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-[#faf5ff] px-4 py-3 text-sm dark:bg-transparent">
                  <Lightbulb className="size-5 shrink-0 text-[#ca8a04]" aria-hidden />
                  <p className="min-w-0 flex-1">
                    <span className="font-semibold text-[#6b21a8] dark:text-[#d8b4fe]">AI Suggestion: </span>
                    {insightText(insights[0], currency).text}
                  </p>
                  <Link href={insightText(insights[0], currency).href} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 font-medium text-fg hover:bg-bg-subtle">
                    {insights[0].key === "deals_close_to_winning" ? "View Leads" : "View"} <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </div>
              ) : null}
            </div>
          </div>

          {turns.length > 0 ? <Conversation turns={turns} currency={currency} busy={busy} onAsk={submit} userName={name} /> : null}

          <div className="mt-auto flex flex-col gap-3">
            <ul className="flex flex-wrap gap-2" aria-label="Suggestions">
              {CHIPS.map((chip) => (
                <li key={chip.label}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => (chip.prompt ? submit(chip.prompt) : open("task"))}
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-fg shadow-sm hover:bg-bg-subtle disabled:opacity-60"
                  >
                    <chip.icon className="size-4 text-[#15803d]" aria-hidden />
                    {chip.label}
                  </button>
                </li>
              ))}
            </ul>
            <AskForm onSubmit={submit} busy={busy} placeholder="Ask anything… (e.g., create follow-up, write message, show report)" voice large />
          </div>
        </section>

        <aside aria-label="AI tools" className="grid min-w-0 content-start gap-4">
          <section aria-label="AI Quick Actions" className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-base font-bold">
              <Zap className="size-5 text-[#15803d]" aria-hidden /> AI Quick Actions
            </h2>
            <ul className="grid grid-cols-4 gap-2">
              {ASSISTANT_ACTIONS.map((action) => {
                const tile = "flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface px-1 py-3 text-center text-xs font-medium text-fg shadow-sm transition-colors hover:border-brand hover:bg-[#f0fdf4] disabled:opacity-60";
                const body = (
                  <>
                    <action.icon className={cn("size-6", action.ink)} aria-hidden />
                    <span>{action.title}</span>
                    {action.hint ? <span className="text-[10px] text-fg-muted">{action.hint}</span> : null}
                  </>
                );
                if ("href" in action.run) {
                  if (!hasPermission(active, action.run.permission)) return null;
                  return (
                    <li key={action.title}>
                      <Link href={action.run.href} className={tile}>
                        {body}
                      </Link>
                    </li>
                  );
                }
                return (
                  <li key={action.title}>
                    <button type="button" className={tile} disabled={busy} onClick={() => runAction(action)}>
                      {body}
                    </button>
                  </li>
                );
              })}
              <li>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface px-1 py-3 text-center text-xs font-medium text-fg shadow-sm hover:border-brand hover:bg-[#f0fdf4]">
                      <Sparkles className="size-6 text-[#7e22ce]" aria-hidden />
                      More Tools
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    {MORE_TOOLS.map((tool) => (
                      <DropdownMenuItem key={tool.title} onSelect={() => submit(tool.prompt)} disabled={busy}>
                        {tool.title}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            </ul>
          </section>

          <section aria-label="AI Insights & Recommendations" className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <h2 className="mb-2 flex items-center gap-2 text-base font-bold">
              <BarChart3 className="size-5 text-[#15803d]" aria-hidden /> AI Insights &amp; Recommendations
            </h2>
            {dashboard.isPending && dashboard.fetchStatus !== "idle" ? (
              <Skeleton className="h-24 w-full" />
            ) : insights.length === 0 ? (
              <p className="py-3 text-sm text-fg-muted">Nothing needs your attention right now.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {insights.map((insight) => {
                  const { text, href } = insightText(insight, currency);
                  const meta = INSIGHT_ICONS[insight.key];
                  return (
                    <li key={insight.key}>
                      <Link href={href} className="flex items-center gap-2.5 py-2 text-sm hover:text-primary">
                        <meta.icon className={cn("size-5 shrink-0", meta.ink)} aria-hidden />
                        <span className="flex-1">{text}</span>
                        <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <RecentActions recent={assistant.recent} />
        </aside>
      </div>
    </div>
  );
}

/** This week's figures and today's follow-ups, read from the CRM (not generated). */
function TodayCard({ first, currency, canActivities }: { first: string; currency: string; canActivities: boolean }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const dashboard = useQuery({ queryKey: queryKeys.dashboard("7d", undefined, 6), queryFn: () => getDashboard("7d"), enabled: hasPermission(active, "dashboards.view"), staleTime: 60_000 });
  const summary = useQuery({ queryKey: crmKeys.activitySummary("me"), queryFn: () => activitySummary("me"), enabled: canActivities, staleTime: 30_000 });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = useQuery({ queryKey: crmKeys.myDay(tz), queryFn: () => getMyDay(tz), enabled: canActivities, staleTime: 30_000 });
  const invalidate = useInvalidateActivities();
  const complete = useMutation({ mutationFn: (a: Activity) => completeActivity(a.id, a.version), onSuccess: (saved) => invalidate(saved) });
  const d = dashboard.data;
  const versus = "compared with the 7 days before";
  const followUps = React.useMemo(() => (day.data ? [...day.data.calls, ...day.data.tasks, ...day.data.events].filter((a) => a.start_at).sort((x, y) => (x.start_at ?? "").localeCompare(y.start_at ?? "")) : []), [day.data]);
  const tiles: { label: string; value: string | undefined; change: ReturnType<typeof percentChange>; icon: Icon; tint: string }[] = [
    { label: "New Leads", value: d ? String(d.contacts_created ?? "—") : undefined, change: null, icon: Users, tint: "bg-[#dcfce7] text-[#15803d]" },
    { label: "Deals", value: d ? String(d.deals_created ?? "—") : undefined, change: d?.previous ? percentChange(d.deals_created, d.previous.deals_created, versus) : null, icon: Layers, tint: "bg-[#dbeafe] text-[#1d4ed8]" },
    { label: "Revenue", value: d ? (d.deals_won ? formatMoney(d.deals_won.amount, currency) : "—") : undefined, change: d?.previous && d.deals_won ? percentChange(Number(d.deals_won.amount), Number(d.previous.deals_won.amount), versus) : null, icon: IndianRupee, tint: "bg-[#ffedd5] text-[#c2410c]" },
    { label: "Pending Follow-ups", value: summary.data ? String(summary.data.follow_ups ?? summary.data.due_today) : canActivities ? undefined : "—", change: null, icon: CheckSquare, tint: "bg-[#f3e8ff] text-[#7e22ce]" },
  ];
  return (
    <div>
      <p className="text-base font-semibold text-fg">Here&apos;s your CRM summary for this week{first ? `, ${first}` : ""}:</p>
      <ul className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-border p-3 md:grid-cols-4" aria-label="This week">
        {tiles.map((t) => (
          <li key={t.label} className="flex items-center gap-2.5">
            <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", t.tint)} aria-hidden>
              <t.icon className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs text-fg-muted">{t.label}</span>
              {t.value === undefined ? <Skeleton className="h-6 w-14" /> : <span className="block text-lg font-bold tabular-nums text-fg">{t.value}</span>}
              {t.change ? <ChangeBadge change={t.change} /> : null}
            </span>
          </li>
        ))}
      </ul>
      {canActivities ? (
        <div className="mt-3 rounded-xl border border-border p-3">
          <h3 className="mb-2 text-sm font-bold text-fg">Your Follow-up Tasks (Today)</h3>
          {day.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : followUps.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing scheduled for today.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {followUps.slice(0, 5).map((a) => {
                const action = KIND_ACTION[a.kind];
                return (
                  <li key={a.id} className="flex items-center gap-2.5 text-sm">
                    <input type="checkbox" className="size-4 accent-[var(--kl-brand)]" aria-label={`Mark ${a.title} as done`} checked={a.status === "completed"} disabled={a.status === "completed" || complete.isPending} onChange={() => complete.mutate(a)} />
                    <span className="min-w-0 flex-1 truncate">{a.title}</span>
                    <span className="shrink-0 tabular-nums text-fg-muted">({new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(a.start_at!))})</span>
                    <Link href={`/activities?open=${encodeURIComponent(a.id)}`} className="inline-flex w-28 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-bg-subtle">
                      <action.icon className={cn("size-4", action.ink)} aria-hidden /> {action.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Recent assistant conversations (saved per member), newest first. */
function RecentActions({ recent }: { recent: { id: string; title: string; last_message_at: string | null }[] }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? recent : recent.slice(0, 4);
  return (
    <section aria-label="Recent AI Actions" className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <History className="size-5 text-[#15803d]" aria-hidden /> Recent AI Actions
        </h2>
        {recent.length > 4 ? (
          <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => setAll((v) => !v)}>
            {all ? "Show less" : "View All"}
          </button>
        ) : null}
      </div>
      {recent.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">Questions you ask the assistant appear here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {shown.map((item) => (
            <li key={item.id} className="flex items-center gap-2.5 py-2 text-sm">
              <CheckSquare className="size-4 shrink-0 text-[#15803d]" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-xs text-fg-muted">{relativeTime(item.last_message_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
