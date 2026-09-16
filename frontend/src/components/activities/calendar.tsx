"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { formatTime, kindColorClasses, startOfDay, toDateInput } from "@/components/activities/activity-utils";
import { Button } from "@/components/ui/button";
import { calendarActivities } from "@/lib/api/crm";
import type { Activity } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";

export type CalendarView = "month" | "week" | "day";

const DAY_MS = 86_400_000;
const FIRST_HOUR = 7;
const LAST_HOUR = 21;
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => FIRST_HOUR + i);
const ROW_PX = 44; // matches h-11
const MAX_MONTH_CHIPS = 3;

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}
/** Monday-first week. */
function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const offset = (day.getDay() + 6) % 7;
  return addDays(day, -offset);
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Six rows of seven days, Monday-first, so the grid is stable month to month. */
export function monthGrid(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function visibleDays(view: CalendarView, cursor: Date): Date[] {
  if (view === "month") return monthGrid(cursor);
  if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));
  return [cursor];
}

function rangeLabel(view: CalendarView, cursor: Date): string {
  const long = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  if (view === "month") return long.format(cursor);
  if (view === "day") return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(cursor);
  const start = startOfWeek(cursor);
  const end = addDays(start, 6);
  const short = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  return `${short.format(start)} – ${short.format(end)}, ${end.getFullYear()}`;
}

/** Events keyed by local `YYYY-MM-DD`, sorted by start within each day. */
function groupByDay(activities: Activity[]): Map<string, Activity[]> {
  const out = new Map<string, Activity[]>();
  for (const a of activities) {
    if (!a.start_at) continue;
    const key = toDateInput(a.start_at);
    const list = out.get(key) ?? [];
    list.push(a);
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.all_day) - Number(a.all_day) || (a.start_at ?? "").localeCompare(b.start_at ?? ""));
  return out;
}

function EventChip({ activity, onSelect, className, style }: { activity: Activity; onSelect: (a: Activity) => void; className?: string; style?: React.CSSProperties }) {
  const time = activity.all_day ? "All day" : formatTime(activity.start_at);
  const done = activity.status === "completed" || activity.status === "cancelled";
  return (
    <button
      type="button"
      onClick={() => onSelect(activity)}
      title={`${time} ${activity.title}`}
      style={style}
      className={cn(
        "flex w-full items-baseline gap-1 overflow-hidden rounded-sm border px-1 text-left text-[12px] leading-5 hover:brightness-95 focus-visible:outline-2 focus-visible:outline-ring/40",
        kindColorClasses(activity.kind),
        done && "opacity-60 line-through",
        className,
      )}
    >
      <span className="shrink-0 tabular-nums">{activity.all_day ? "" : formatTime(activity.start_at)}</span>
      <span className="truncate font-medium">{activity.title}</span>
    </button>
  );
}

/**
 * Month / week / day calendar built in-house. Fetches the visible range (padded a day each side for
 * timezone edges) and renders one chip per activity; clicking a chip opens it.
 */
export function Calendar({ onSelect, onCreate }: { onSelect: (activity: Activity) => void; onCreate?: (startAt: string) => void }) {
  const [view, setView] = React.useState<CalendarView>("month");
  const [cursor, setCursor] = React.useState<Date>(() => startOfDay(new Date()));
  const [owner, setOwner] = React.useState<"me" | undefined>("me");
  const today = React.useMemo(() => startOfDay(new Date()), []);

  // Phones default to the day view; decided after mount so server and client render the same markup.
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 640) setView("day");
  }, []);

  const days = React.useMemo(() => visibleDays(view, cursor), [view, cursor]);
  const from = toDateInput(addDays(days[0]!, -1));
  const to = toDateInput(addDays(days[days.length - 1]!, 1));
  const events = useQuery({
    queryKey: crmKeys.calendar(from, to, { owner }),
    queryFn: () => calendarActivities(from, to, owner ? { owner } : {}),
    staleTime: 30_000,
  });
  const byDay = React.useMemo(() => groupByDay(events.data?.results ?? []), [events.data]);

  const step = (direction: -1 | 1) =>
    setCursor((c) => {
      if (view === "month") return new Date(c.getFullYear(), c.getMonth() + direction, 1);
      return addDays(c, direction * (view === "week" ? 7 : 1));
    });

  const weekdays = React.useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    const start = startOfWeek(today);
    return Array.from({ length: 7 }, (_, i) => fmt.format(addDays(start, i)));
  }, [today]);

  const openDay = (day: Date) => {
    setCursor(day);
    setView("day");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-md border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="secondary" size="sm" onClick={() => setCursor(today)}>
          Today
        </Button>
        <div className="inline-flex items-center">
          <Button variant="ghost" size="icon-sm" onClick={() => step(-1)} aria-label={`Previous ${view}`}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => step(1)} aria-label={`Next ${view}`}>
            <ChevronRight />
          </Button>
        </div>
        <h2 className="text-sm font-semibold text-fg" aria-live="polite">
          {rangeLabel(view, cursor)}
        </h2>
        {events.isFetching ? <Loader2 className="size-3.5 animate-spin text-fg-subtle" aria-label="Loading events" /> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-bg-subtle p-0.5" role="group" aria-label="Whose calendar">
            {(
              [
                ["me", "My calendar"],
                [undefined, "Everyone"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => setOwner(value)}
                aria-pressed={owner === value}
                className={cn("h-7 rounded-sm px-2.5 text-xs font-medium transition-colors", owner === value ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-bg-subtle p-0.5" role="group" aria-label="Calendar view">
            {(["month", "week", "day"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn("h-7 rounded-sm px-2.5 text-xs font-medium capitalize transition-colors", view === v ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {events.isError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-danger-soft px-3 py-2 text-sm text-danger">
          <span>Could not load the calendar. {errorMessage(events.error)}</span>
          <Button size="sm" variant="secondary" onClick={() => events.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      {view === "month" ? (
        <div className="grid flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(5.5rem,1fr))]" role="grid" aria-label="Month" aria-busy={events.isPending || undefined}>
          {weekdays.map((d) => (
            <div key={d} role="columnheader" className="border-b border-border px-2 py-1 text-[12px] font-medium uppercase tracking-wide text-fg-subtle">
              {d}
            </div>
          ))}
          {days.map((day, i) => {
            const inMonth = day.getMonth() === cursor.getMonth();
            const isToday = sameDay(day, today);
            const list = byDay.get(toDateInput(day)) ?? [];
            const extra = list.length - MAX_MONTH_CHIPS;
            return (
              <div
                key={day.toISOString()}
                role="gridcell"
                aria-label={day.toDateString()}
                className={cn("flex min-w-0 flex-col gap-0.5 border-b border-r border-border p-1 text-xs", i % 7 === 6 && "border-r-0", !inMonth && "bg-surface-sunken text-fg-subtle")}
              >
                <button
                  type="button"
                  onClick={() => (onCreate && list.length === 0 ? onCreate(`${toDateInput(day)}T09:00`) : openDay(day))}
                  aria-label={`${day.toDateString()}${list.length ? `, ${list.length} activities` : onCreate ? ", schedule here" : ""}`}
                  className={cn("inline-flex size-5 items-center justify-center self-start rounded-full tabular-nums hover:bg-bg-subtle", isToday && "bg-primary font-semibold text-primary-fg hover:bg-primary-hover")}
                >
                  {day.getDate()}
                </button>
                {list.slice(0, MAX_MONTH_CHIPS).map((a) => (
                  <EventChip key={a.id} activity={a} onSelect={onSelect} />
                ))}
                {extra > 0 ? (
                  <button type="button" onClick={() => openDay(day)} className="self-start px-1 text-[12px] font-medium text-fg-muted hover:text-fg">
                    +{extra} more
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className={cn("grid", view === "week" ? "grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]" : "grid-cols-[3.5rem_minmax(0,1fr)]")} role="grid" aria-label={view === "week" ? "Week" : "Day"} aria-busy={events.isPending || undefined}>
            <div className="sticky top-0 z-10 border-b border-border bg-surface" />
            {days.map((day) => (
              <div key={day.toISOString()} role="columnheader" className="sticky top-0 z-10 border-b border-l border-border bg-surface px-2 py-1 text-xs">
                <span className="text-fg-subtle">{new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day)}</span>{" "}
                <span className={cn("font-semibold tabular-nums", sameDay(day, today) && "rounded-full bg-primary px-1.5 text-primary-fg")}>{day.getDate()}</span>
              </div>
            ))}
            {/* all-day row */}
            <div className="border-b border-border pr-2 pt-0.5 text-right text-[12px] text-fg-subtle">all day</div>
            {days.map((day) => {
              const list = (byDay.get(toDateInput(day)) ?? []).filter((a) => a.all_day);
              return (
                <div key={`allday-${day.toISOString()}`} role="gridcell" className="flex min-h-6 flex-col gap-0.5 border-b border-l border-border p-0.5">
                  {list.map((a) => (
                    <EventChip key={a.id} activity={a} onSelect={onSelect} />
                  ))}
                </div>
              );
            })}
            {/* hour rows: the time gutter plus one relatively-positioned column per day holding its timed events */}
            <div className="contents">
              {HOURS.map((hour) => (
                <div key={hour} className="col-start-1 h-11 border-b border-border pr-2 pt-0.5 text-right text-[12px] tabular-nums text-fg-subtle">{`${String(hour).padStart(2, "0")}:00`}</div>
              ))}
            </div>
            {days.map((day, col) => {
              const list = (byDay.get(toDateInput(day)) ?? []).filter((a) => !a.all_day);
              return (
                <div
                  key={`col-${day.toISOString()}`}
                  role="gridcell"
                  aria-label={`${day.toDateString()} events`}
                  className="relative border-l border-border"
                  style={{ gridColumn: col + 2, gridRow: `3 / span ${HOURS.length}` }}
                  onDoubleClick={onCreate ? () => onCreate(`${toDateInput(day)}T09:00`) : undefined}
                >
                  {HOURS.map((hour) => (
                    <div key={hour} className="h-11 border-b border-border" aria-hidden />
                  ))}
                  {list.map((a) => {
                    const start = new Date(a.start_at ?? "");
                    const startHour = Math.min(Math.max(start.getHours() + start.getMinutes() / 60, FIRST_HOUR), LAST_HOUR + 1);
                    const minutes = a.duration_minutes ?? (a.end_at ? (new Date(a.end_at).getTime() - start.getTime()) / 60_000 : 30);
                    const height = Math.max(22, Math.min(minutes / 60, LAST_HOUR + 1 - startHour) * ROW_PX);
                    return (
                      <EventChip
                        key={a.id}
                        activity={a}
                        onSelect={onSelect}
                        className="absolute left-0.5 right-0.5 items-start"
                        style={{ top: (startHour - FIRST_HOUR) * ROW_PX, height }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
