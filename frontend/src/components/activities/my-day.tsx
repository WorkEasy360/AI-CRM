"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Sun } from "lucide-react";
import { ActivityItem } from "@/components/activities/activity-item";
import { browserTimezone } from "@/components/activities/activity-utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { getMyDay } from "@/lib/api/crm";
import type { Activity, MyDay as MyDayData } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";

const SECTIONS: { key: keyof Pick<MyDayData, "overdue" | "tasks" | "events" | "calls" | "no_date">; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "tasks", label: "Tasks" },
  { key: "events", label: "Events" },
  { key: "calls", label: "Calls" },
  { key: "no_date", label: "No date" },
];

function dayTitle(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return "Today";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(new Date(y, m - 1, d));
}

/** The signed-in member's day: overdue, today's tasks / events / calls, undated tasks, and what is done. */
export function MyDay({ onCreate }: { onCreate?: () => void }) {
  const tz = React.useMemo(() => browserTimezone(), []);
  const query = useQuery({ queryKey: crmKeys.myDay(tz), queryFn: () => getMyDay(tz) });

  if (query.isPending) return <SkeletonRows rows={4} />;
  if (query.isError) {
    return (
      <EmptyState
        title="Could not load your day"
        description={errorMessage(query.error)}
        action={
          <Button variant="secondary" size="sm" onClick={() => query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const day = query.data;
  const sections = SECTIONS.map((s) => ({ ...s, items: day[s.key] as Activity[] })).filter((s) => s.items.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{dayTitle(day.date)}</h2>
        <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
          <CheckCircle2 className={cn("size-3.5", day.completed_today > 0 ? "text-success" : "text-fg-subtle")} aria-hidden />
          <span className="font-semibold tabular-nums">{day.completed_today}</span> completed today
        </span>
      </div>
      {sections.length === 0 ? (
        <EmptyState
          icon={<Sun />}
          title="Nothing planned today"
          description="Tasks due today, today's events and calls, and anything overdue show up here."
          action={
            onCreate ? (
              <Button size="sm" onClick={onCreate}>
                New task
              </Button>
            ) : null
          }
        />
      ) : (
        sections.map(({ key, label, items }) => (
          <section key={key} aria-label={label}>
            <h3 className={cn("mb-1.5 text-xs font-semibold uppercase tracking-wide", key === "overdue" ? "text-danger" : "text-fg-subtle")}>
              {label} <span className="font-normal text-fg-subtle">· {items.length}</span>
            </h3>
            <ul className="flex flex-col gap-1.5">
              {items.map((a) => (
                <li key={a.occurrence_key ?? a.id}>
                  <ActivityItem activity={a} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
