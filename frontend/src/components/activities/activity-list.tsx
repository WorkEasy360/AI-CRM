"use client";

import * as React from "react";
import { CalendarDays, ListTodo, Phone, Plus, Search, X } from "lucide-react";
import { ActivityItem } from "@/components/activities/activity-item";
import { KIND_LABELS, isDone, startOfDay } from "@/components/activities/activity-utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { listActivities } from "@/lib/api/crm";
import type { Activity, ActivityKind, ListParams } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { useDebounced } from "@/lib/crm/use-list-params";
import { useCursorList } from "@/lib/use-cursor-list";

type View = "mine" | "all" | "done";
const ALL = "all";

const DUE_OPTIONS = [
  { value: ALL, label: "Any time" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "upcoming", label: "Upcoming" },
  { value: "none", label: "No date" },
];
const SORT_OPTIONS = [
  { value: "start_at", label: "Soonest first" },
  { value: "-start_at", label: "Latest first" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
  { value: "-created_at", label: "Newest created" },
];

const EMPTY: Record<ActivityKind, { icon: React.ReactNode; title: string; description: string }> = {
  task: { icon: <ListTodo />, title: "No tasks here", description: "Tasks are to-dos with a due date, linked to a contact, company or deal. Add one so the next step is never forgotten." },
  call: { icon: <Phone />, title: "No calls here", description: "Log calls you made or schedule the next one. Outcomes and notes land on the contact's timeline." },
  meeting: { icon: <CalendarDays />, title: "No meetings here", description: "Scheduled meetings show on the calendar with attendees, location and a reminder." },
};

type Group = "Overdue" | "Today" | "Tomorrow" | "Later" | "No date" | "Completed";
const GROUP_ORDER: Group[] = ["Overdue", "Today", "Tomorrow", "Later", "No date", "Completed"];

function groupOf(a: Activity, today: Date): Group {
  if (isDone(a)) return "Completed";
  if (a.is_overdue) return "Overdue";
  if (!a.start_at) return "No date";
  const day = startOfDay(new Date(a.start_at)).getTime();
  const diff = Math.round((day - today.getTime()) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return "Later";
}

function viewOf(params: ListParams): View {
  return params.view === "all" || params.view === "done" ? params.view : "mine";
}

/** One kind's list (Tasks / Meetings / Calls tab): view, search, due filter, sort, grouped rows. */
export function ActivityList({
  kind,
  params,
  setParam,
  setParams,
  canCreate,
  onCreate,
}: {
  kind: ActivityKind;
  params: ListParams;
  setParam: (key: string, value: string | undefined) => void;
  setParams: (patch: ListParams) => void;
  canCreate: boolean;
  onCreate: (kind: ActivityKind) => void;
}) {
  const view = viewOf(params);
  const [draft, setDraft] = React.useState(params.q ?? "");
  const debounced = useDebounced(draft, 300);
  React.useEffect(() => {
    if ((params.q ?? "") !== debounced) setParam("q", debounced || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  React.useEffect(() => {
    if (params.q === undefined && draft !== "") setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.q]);

  const sort = params.sort ?? (view === "done" ? "-start_at" : "start_at");
  const apiParams = React.useMemo<ListParams>(
    () => ({
      kind,
      owner: view === "mine" ? "me" : undefined,
      open: view === "done" ? "false" : "true",
      q: params.q,
      due: params.due,
      sort,
    }),
    [kind, view, params.q, params.due, sort],
  );
  const list = useCursorList<Activity>(crmKeys.activities(apiParams), (cursor) => listActivities(apiParams, cursor), true, { recordKey: (a) => crmKeys.activity(a.id) });

  const today = React.useMemo(() => startOfDay(new Date()), []);
  const grouped = React.useMemo(() => {
    const byGroup = new Map<Group, Activity[]>();
    for (const a of list.items) {
      const g = groupOf(a, today);
      byGroup.set(g, [...(byGroup.get(g) ?? []), a]);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ group: g, items: byGroup.get(g) ?? [] }));
  }, [list.items, today]);
  const grouping = sort === "start_at" || sort === "-start_at";

  const label = KIND_LABELS[kind].plural.toLowerCase();
  const filtered = Boolean(params.q || params.due);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={view} onValueChange={(v) => setParams({ view: v === "mine" ? undefined : v, sort: undefined })}>
          <SelectTrigger className="h-8 w-40 font-medium" aria-label="View">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mine">My {label}</SelectItem>
            <SelectItem value="all">All {label}</SelectItem>
            <SelectItem value="done">Completed</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label={`Search ${label}`} placeholder={`Search ${label}…`} value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 pl-8" maxLength={200} />
        </div>
        <Select value={params.due ?? ALL} onValueChange={(v) => setParam("due", v === ALL ? undefined : v)}>
          <SelectTrigger className="h-8 w-36" aria-label="Due">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DUE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={() => setParams({ q: undefined, due: undefined })} className="text-fg-muted">
            <X /> Clear
          </Button>
        ) : null}
        <div className="ml-auto">
          <Select value={sort} onValueChange={(v) => setParam("sort", v)}>
            <SelectTrigger className="h-8 w-40" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {list.isPending ? (
        <SkeletonRows rows={4} />
      ) : list.isError ? (
        <EmptyState
          title={`Could not load ${label}`}
          description={errorMessage(list.error)}
          action={
            <Button variant="secondary" size="sm" onClick={() => list.refetch()}>
              Try again
            </Button>
          }
        />
      ) : list.items.length === 0 ? (
        <EmptyState
          icon={EMPTY[kind].icon}
          title={filtered ? `No ${label} match` : view === "done" ? `No completed ${label}` : EMPTY[kind].title}
          description={filtered ? "Try a different search or clear the filters." : view === "done" ? "Items you complete or cancel move here." : EMPTY[kind].description}
          action={
            filtered ? (
              <Button variant="secondary" size="sm" onClick={() => setParams({ q: undefined, due: undefined })}>
                Clear filters
              </Button>
            ) : canCreate && view !== "done" ? (
              <Button size="sm" onClick={() => onCreate(kind)}>
                <Plus /> New {KIND_LABELS[kind].singular.toLowerCase()}
              </Button>
            ) : null
          }
        />
      ) : grouping ? (
        <div className={list.isPlaceholderData ? "opacity-60" : undefined}>
          {grouped.map(({ group, items }) => (
            <section key={group} aria-label={group} className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                {group} <span className="font-normal text-fg-subtle">· {items.length}</span>
              </h3>
              <ul className="flex flex-col gap-1.5">
                {items.map((a) => (
                  <li key={a.id}>
                    <ActivityItem activity={a} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className={list.isPlaceholderData ? "flex flex-col gap-1.5 opacity-60" : "flex flex-col gap-1.5"}>
          {list.items.map((a) => (
            <li key={a.id}>
              <ActivityItem activity={a} />
            </li>
          ))}
        </ul>
      )}
      {list.hasMore ? (
        <Button variant="secondary" size="sm" onClick={() => list.loadMore()} loading={list.isLoadingMore} className="self-center">
          Load more
        </Button>
      ) : null}
    </div>
  );
}
