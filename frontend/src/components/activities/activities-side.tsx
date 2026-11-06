"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, CalendarCheck, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Phone } from "lucide-react";
import { browserTimezone, startOfDay } from "@/components/activities/activity-utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getMyDay, listActivities } from "@/lib/api/crm";
import type { Activity, ActivityKind, ActivitySummary } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<ActivityKind, React.ComponentType<{ className?: string }>> = { task: CheckCircle2, call: Phone, meeting: CalendarDays };
const KIND_TINT: Record<ActivityKind, string> = { task: "text-[#15803d]", call: "text-[#15803d]", meeting: "text-[#7e22ce]" };

const time = (value: string | null) => (value ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "");
const shortDate = (value: string | null) => (value ? new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" }).format(new Date(value)) : "");
const related = (a: Activity) => a.company?.name || a.deal?.name || a.contact?.name || "";

function Card({ title, icon, action, children, tone }: { title: React.ReactNode; icon: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; tone?: "danger" }) {
  return (
    <section aria-label={typeof title === "string" ? title : undefined} className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className={cn("flex items-center gap-2 text-base font-bold", tone === "danger" ? "text-danger" : "text-fg")}>
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Today's timed activities as a timeline. */
export function TodaySchedule({ onOpen }: { onOpen: (a: Activity) => void }) {
  const tz = browserTimezone();
  const day = useQuery({ queryKey: crmKeys.myDay(tz), queryFn: () => getMyDay(tz), staleTime: 30_000 });
  const items = React.useMemo(() => (day.data ? [...day.data.events, ...day.data.calls, ...day.data.tasks].filter((a) => a.start_at).sort((x, y) => (x.start_at ?? "").localeCompare(y.start_at ?? "")) : []), [day.data]);
  const today = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(new Date());
  return (
    <Card title="Today's Schedule" icon={<CalendarCheck className="size-5 text-brand" aria-hidden />} action={<span className="text-xs font-medium text-fg-muted">{today}</span>}>
      {day.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : day.isError ? (
        <p className="text-sm text-fg-muted">Your schedule is unavailable right now.</p>
      ) : items.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">Nothing scheduled for today.</p>
      ) : (
        <ol className="relative flex flex-col gap-2 pl-4 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border">
          {items.slice(0, 6).map((a) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <li key={a.id} className="relative flex items-center gap-2">
                <span className="absolute -left-4 top-1/2 size-2.5 -translate-y-1/2 rounded-full border-2 border-brand bg-surface" aria-hidden />
                <span className="w-16 shrink-0 text-xs font-medium tabular-nums">{time(a.start_at)}</span>
                <button type="button" onClick={() => onOpen(a)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left hover:bg-bg-subtle">
                  <Icon className={cn("size-4 shrink-0", KIND_TINT[a.kind])} aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{a.title}</span>
                    {related(a) ? <span className="block truncate text-xs text-fg-muted">{related(a)}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/** A month grid; today is the green disc and the picked day is outlined. Picking a day filters the list. */
export function MiniCalendar({ selected, onPick }: { selected?: string; onPick: (isoDate: string | undefined) => void }) {
  const [cursor, setCursor] = React.useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const today = startOfDay(new Date());
  const first = new Date(cursor);
  const lead = first.getDay();
  const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => new Date(cursor.getFullYear(), cursor.getMonth(), i + 1))];
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2026, 1, i + 1)));
  return (
    <section aria-label="Calendar" className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}>
          <ChevronLeft />
        </Button>
        <p className="text-base font-bold" aria-live="polite">
          {new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(cursor)}
        </p>
        <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}>
          <ChevronRight />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-xs">
        {weekdays.map((w) => (
          <span key={w} className="py-1 font-medium text-fg-muted" aria-hidden>
            {w}
          </span>
        ))}
        {cells.map((d, i) =>
          d ? (
            <button
              key={iso(d)}
              type="button"
              aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(d)}
              aria-current={d.getTime() === today.getTime() ? "date" : undefined}
              aria-pressed={selected === iso(d)}
              onClick={() => onPick(selected === iso(d) ? undefined : iso(d))}
              className={cn(
                "mx-auto flex size-8 items-center justify-center rounded-full text-sm tabular-nums transition-colors hover:bg-bg-subtle",
                d.getTime() === today.getTime() && "bg-brand font-semibold text-brand-fg hover:bg-brand-hover",
                selected === iso(d) && "ring-2 ring-brand",
              )}
            >
              {d.getDate()}
            </button>
          ) : (
            <span key={`pad-${i}`} />
          ),
        )}
      </div>
    </section>
  );
}

function MiniList({ due, onOpen, urgent }: { due: "week" | "overdue"; onOpen: (a: Activity) => void; urgent?: boolean }) {
  const params = { due, sort: "start_at", limit: "3", top_level: "1" };
  const list = useQuery({ queryKey: crmKeys.activities({ side: due, ...params }), queryFn: () => listActivities(params), staleTime: 30_000 });
  if (list.isPending) return <Skeleton className="h-20 w-full" />;
  if (list.isError) return <p className="text-sm text-fg-muted">Unavailable right now.</p>;
  if (list.data.results.length === 0) return <p className="py-2 text-sm text-fg-muted">{urgent ? "Nothing overdue." : "Nothing coming up this week."}</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {list.data.results.map((a) => {
        const Icon = KIND_ICON[a.kind];
        return (
          <li key={a.id}>
            <button type="button" onClick={() => onOpen(a)} className="flex w-full items-center gap-2 rounded-md py-1 text-left text-sm hover:text-primary">
              <Icon className={cn("size-4 shrink-0", KIND_TINT[a.kind])} aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {a.title}
                {related(a) ? <span className="text-fg-muted"> – {related(a)}</span> : null}
              </span>
              <span className={cn("shrink-0 text-xs tabular-nums", urgent ? "font-medium text-danger" : "text-fg-muted")}>
                {urgent ? shortDate(a.start_at) : `${shortDate(a.start_at)}, ${time(a.start_at)}`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function UpcomingCard({ summary, onOpen, onViewAll }: { summary: ActivitySummary | undefined; onOpen: (a: Activity) => void; onViewAll: () => void }) {
  return (
    <Card
      title={`Upcoming${summary?.due_week !== undefined ? ` (${summary.due_week})` : ""}`}
      icon={<CheckCircle2 className="size-5 text-brand" aria-hidden />}
      action={<Button variant="link" size="sm" onClick={onViewAll} className="h-auto p-0 text-primary">View All</Button>}
    >
      <MiniList due="week" onOpen={onOpen} />
    </Card>
  );
}

export function OverdueCard({ summary, onOpen, onViewAll }: { summary: ActivitySummary | undefined; onOpen: (a: Activity) => void; onViewAll: () => void }) {
  return (
    <Card
      title={`Overdue${summary ? ` (${summary.overdue})` : ""}`}
      tone="danger"
      icon={<AlarmClock className="size-5 text-danger" aria-hidden />}
      action={<Button variant="link" size="sm" onClick={onViewAll} className="h-auto p-0 text-primary">View All</Button>}
    >
      <MiniList due="overdue" onOpen={onOpen} urgent />
    </Card>
  );
}
