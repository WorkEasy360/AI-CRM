"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronLeft, ChevronRight, Phone, SquareCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { calendarActivities, getRecordCalendar } from "@/lib/api/crm";
import type { Activity, EntityType, ListParams } from "@/lib/api/crm-types";
import { ENTITY_PATHS } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";
import { useModuleSchema } from "@/lib/views";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // Monday first
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/**
 * Records placed on a month calendar by one of their date fields (a deal's expected close, a contact's
 * next activity ...), with the member's events, task due dates and scheduled calls alongside.
 */
export function RecordCalendar({
  entity,
  filters,
  dateField,
  onDateFieldChange,
  includeActivities,
  onIncludeActivitiesChange,
}: {
  entity: EntityType;
  filters: ListParams;
  dateField: string | undefined;
  onDateFieldChange: (key: string) => void;
  includeActivities: boolean;
  onIncludeActivitiesChange: (on: boolean) => void;
}) {
  const schema = useModuleSchema(entity);
  const dateFields = (schema.data?.fields ?? []).filter((f) => (f.type === "date" || f.type === "datetime") && !f.custom);
  const field = dateFields.find((f) => f.key === dateField) ?? dateFields[0];
  const [month, setMonth] = React.useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const days = React.useMemo(() => monthGrid(month), [month]);
  const from = isoDay(days[0]!);
  const to = isoDay(days[days.length - 1]!);
  const params = React.useMemo(() => ({ ...filters, date_field: field?.key ?? "", from, to }), [filters, field, from, to]);
  const records = useQuery({
    queryKey: crmKeys.recordCalendar(entity, params),
    queryFn: () => getRecordCalendar(entity, params),
    enabled: Boolean(field),
    placeholderData: (prev) => prev,
  });
  const activities = useQuery({
    queryKey: crmKeys.calendar(from, to, { owner: "me" }),
    queryFn: () => calendarActivities(from, to, { owner: "me" }),
    enabled: includeActivities,
  });

  const byDay = React.useMemo(() => {
    const map = new Map<string, { records: { id: string; title: string }[]; activities: Activity[] }>();
    const bucket = (day: string) => {
      let b = map.get(day);
      if (!b) map.set(day, (b = { records: [], activities: [] }));
      return b;
    };
    for (const item of records.data?.items ?? []) {
      const day = item.date.length > 10 ? isoDay(new Date(item.date)) : item.date;
      bucket(day).records.push({ id: item.id, title: item.title || "Untitled" });
    }
    if (includeActivities) {
      for (const a of activities.data?.results ?? []) {
        if (!a.start_at) continue;
        if (a.kind === "call" && a.status !== "open" && a.status !== "in_progress") continue;
        bucket(isoDay(new Date(a.start_at))).activities.push(a);
      }
    }
    return map;
  }, [records.data, activities.data, includeActivities]);

  if (schema.isSuccess && !field) return <EmptyState title="No date fields" description="This module has no date field to place records on a calendar." />;
  const today = isoDay(new Date());
  const label = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          <ChevronLeft />
        </Button>
        <span className="min-w-32 text-center text-sm font-semibold text-fg" aria-live="polite">
          {label}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          <ChevronRight />
        </Button>
        <span className="ml-2">Place by</span>
        {field ? (
          <Select value={field.key} onValueChange={onDateFieldChange}>
            <SelectTrigger className="h-8 w-44" aria-label="Date field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dateFields.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <label className="ml-auto flex items-center gap-2">
          <Switch checked={includeActivities} onCheckedChange={onIncludeActivitiesChange} aria-label="Show my events, tasks and calls" />
          My events, tasks and calls
        </label>
      </div>
      {records.isError ? <p className="mb-2 text-sm text-danger">{errorMessage(records.error)}</p> : null}
      {records.data?.truncated ? <p className="mb-2 text-xs text-fg-subtle">Showing the first 1,000 records of this month. Narrow the filters to see the rest.</p> : null}
      <div className="grid grid-cols-7 overflow-hidden rounded-md border border-border bg-surface text-xs" role="grid" aria-label={`Calendar, ${label}`}>
        {WEEKDAYS.map((d) => (
          <div key={d} role="columnheader" className="border-b border-border bg-bg-subtle px-2 py-1.5 font-semibold text-fg-muted">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const key = isoDay(d);
          const entry = byDay.get(key);
          const outside = d.getMonth() !== month.getMonth();
          return (
            <div key={key} role="gridcell" className={cn("min-h-24 border-b border-r border-border p-1", outside && "bg-bg-subtle/60 text-fg-subtle")}>
              <div className={cn("mb-0.5 text-right text-[11px]", key === today && "font-semibold text-primary")}>{d.getDate()}</div>
              <ul className="flex flex-col gap-0.5">
                {entry?.records.slice(0, 4).map((r) => (
                  <li key={r.id}>
                    <Link prefetch={false} href={`/${ENTITY_PATHS[entity]}/${encodeURIComponent(r.id)}`} className="block truncate rounded-sm bg-primary-soft px-1 py-0.5 text-primary hover:underline">
                      {r.title}
                    </Link>
                  </li>
                ))}
                {entry && entry.records.length > 4 ? <li className="px-1 text-fg-subtle">+{entry.records.length - 4} more</li> : null}
                {entry?.activities.slice(0, 3).map((a) => (
                  <li key={a.occurrence_key ?? a.id} className="flex items-center gap-1 truncate rounded-sm bg-bg-subtle px-1 py-0.5 text-fg-muted" title={a.title}>
                    {a.kind === "call" ? <Phone className="size-3 shrink-0" /> : a.kind === "task" ? <SquareCheck className="size-3 shrink-0" /> : <CalendarClock className="size-3 shrink-0" />}
                    <span className="truncate">{a.title}</span>
                  </li>
                ))}
                {entry && entry.activities.length > 3 ? <li className="px-1 text-fg-subtle">+{entry.activities.length - 3} activities</li> : null}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
