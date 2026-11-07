"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, LayoutList, List, MoreVertical, Phone, Search, Building2, User, Handshake } from "lucide-react";
import { KIND_LABELS, canDeleteActivity, canEditActivity, isDone, startOfDay, useInvalidateActivities } from "@/components/activities/activity-utils";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { completeActivity, deleteActivity, listActivities, reopenActivity } from "@/lib/api/crm";
import { ACTIVITY_KINDS, type Activity, type ActivityKind, type ListParams } from "@/lib/api/crm-types";
import { listMembers } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { useDebounced } from "@/lib/crm/use-list-params";
import { queryKeys, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn } from "@/lib/utils";

const ALL = "__all__";
const KIND_ICON: Record<ActivityKind, React.ComponentType<{ className?: string }>> = { task: CheckCircle2, call: Phone, meeting: CalendarDays };
const KIND_INK: Record<ActivityKind, string> = { task: "text-accent", call: "text-brand", meeting: "text-accent" };

export type DateRange = "any" | "today" | "week" | "month" | "custom";
export const RANGE_LABELS: Record<DateRange, string> = { any: "Any time", today: "Today", week: "This Week", month: "This Month", custom: "Custom" };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The from/to dates (inclusive, local) a range filter sends; weeks start on Sunday as on the calendar. */
export function rangeDates(range: DateRange, now: Date = new Date()): { from?: string; to?: string } {
  const today = startOfDay(now);
  if (range === "today") return { from: iso(today), to: iso(today) };
  if (range === "week") {
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: iso(start), to: iso(end) };
  }
  if (range === "month") return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)) };
  return {};
}

/** The status a row shows: an open meeting still ahead is "Scheduled" (a label, not a stored status). */
export function displayStatus(a: Pick<Activity, "status" | "kind" | "start_at">, now: Date = new Date()): { label: string; className: string } {
  if (a.status === "completed") return { label: "Completed", className: "border-transparent bg-brand-soft text-brand" };
  if (a.status === "cancelled") return { label: "Cancelled", className: "border-transparent bg-bg-subtle text-fg-muted" };
  if (a.status === "in_progress") return { label: "In Progress", className: "border-transparent bg-accent-soft text-accent" };
  if (a.kind === "meeting" && a.start_at && new Date(a.start_at) > now) return { label: "Scheduled", className: "border-transparent bg-accent-soft text-accent" };
  return { label: "Open", className: "border-transparent bg-warning-soft text-warning" };
}

/** "Today, 11:30 AM", "Tomorrow, 11:00 AM", "06 Nov, 04:00 PM"; red when the open item is due today or late. */
export function dueLabel(a: Pick<Activity, "start_at" | "status" | "all_day">, now: Date = new Date()): { text: string; urgent: boolean } {
  if (!a.start_at) return { text: "No date", urgent: false };
  const when = new Date(a.start_at);
  const day = Math.round((startOfDay(when).getTime() - startOfDay(now).getTime()) / 86_400_000);
  const time = a.all_day ? "" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(when);
  const date = day === 0 ? "Today" : day === 1 ? "Tomorrow" : day === -1 ? "Yesterday" : new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" }).format(when);
  const open = !isDone(a);
  return { text: time ? `${date}, ${time}` : date, urgent: open && (day <= 0 || when < now) };
}

function Related({ a }: { a: Activity }) {
  if (a.company) return <Link href={`/companies/${encodeURIComponent(a.company.id)}`} className="inline-flex min-w-0 items-center gap-1.5 text-primary hover:underline"><Building2 className="size-4 shrink-0" aria-hidden /><span className="truncate">{a.company.name}</span></Link>;
  if (a.deal) return <Link href={`/deals/${encodeURIComponent(a.deal.id)}`} className="inline-flex min-w-0 items-center gap-1.5 text-primary hover:underline"><Handshake className="size-4 shrink-0" aria-hidden /><span className="truncate">{a.deal.name}</span></Link>;
  if (a.contact) return <Link href={`/contacts/${encodeURIComponent(a.contact.id)}`} className="inline-flex min-w-0 items-center gap-1.5 text-primary hover:underline"><User className="size-4 shrink-0" aria-hidden /><span className="truncate">{a.contact.name}</span></Link>;
  return <span className="text-fg-subtle">—</span>;
}

/**
 * The WorkEasy360 activity table: filters in one row, then Activity / Related To / Owner / Due / Status / ⋮.
 * ``kind`` fixes the type (Tasks, Calls, Meetings tabs); ``followUps`` lists open follow-ups.
 */
export function ActivityTable({
  kind,
  followUps = false,
  params,
  setParam,
  setParams,
  onEdit,
  onCreate,
  canCreate,
  onShowCalendar,
  onShowGrouped,
}: {
  kind?: ActivityKind;
  followUps?: boolean;
  params: ListParams;
  setParam: (key: string, value: string | undefined) => void;
  setParams: (patch: ListParams) => void;
  onEdit: (activity: Activity) => void;
  onCreate: (kind: ActivityKind) => void;
  canCreate: boolean;
  onShowCalendar: () => void;
  onShowGrouped: () => void;
}) {
  const { data: session } = useSession();
  const active = session?.active;
  const { toast } = useToast();
  const invalidate = useInvalidateActivities();
  const [draft, setDraft] = React.useState(params.q ?? "");
  const debounced = useDebounced(draft, 300);
  const [deleting, setDeleting] = React.useState<Activity | null>(null);
  React.useEffect(() => {
    if ((params.q ?? "") !== debounced) setParam("q", debounced || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const range = ((["today", "week", "month", "custom"] as const).find((r) => r === params.range) ?? "any") as DateRange;
  const dates = range === "custom" ? { from: params.from, to: params.to } : rangeDates(range);
  const query: ListParams = {
    q: params.q,
    kind: kind ?? params.type,
    status: params.status,
    owner: params.owner,
    due: params.due,
    from: dates.from,
    to: dates.to,
    follow_up: followUps ? "1" : undefined,
    top_level: "1",
    sort: "start_at",
  };
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v)) as ListParams;
  const list = useCursorList(crmKeys.activities({ table: "1", ...clean }), (cursor) => listActivities(clean, cursor));

  const toggle = useMutation({
    mutationFn: (a: Activity) => (isDone(a) ? reopenActivity(a.id, a.version) : completeActivity(a.id, a.version)),
    onSuccess: (saved) => invalidate(saved),
    onError: (err) => toast({ tone: "error", title: "Could not update the activity", description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: (a: Activity) => deleteActivity(a.id),
    onSuccess: (_r, a) => {
      setDeleting(null);
      void invalidate(a);
      toast({ tone: "success", title: "Activity deleted" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not delete the activity", description: errorMessage(err) }),
  });

  const filtered = Boolean(params.q || params.type || params.status || params.owner || params.due || range !== "any");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search activities…" aria-label="Search activities" className="h-9 pl-8" maxLength={200} />
        </div>
        {kind ? null : (
          <Select value={params.type ?? ALL} onValueChange={(v) => setParam("type", v === ALL ? undefined : v)}>
            <SelectTrigger className="h-9 w-32" aria-label="Type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Types</SelectItem>
              {ACTIVITY_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABELS[k].plural}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={params.status ?? ALL} onValueChange={(v) => setParam("status", v === ALL ? undefined : v)}>
          <SelectTrigger className="h-9 w-32" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Status</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <OwnerFilter value={params.owner} onChange={(v) => setParam("owner", v)} />
        <Select value={range} onValueChange={(v) => setParams({ range: v === "any" ? undefined : v, ...(v === "custom" ? {} : { from: undefined, to: undefined }) })}>
          <SelectTrigger className="h-9 w-36" aria-label="Date range">
            <CalendarDays className="size-4 text-fg-muted" aria-hidden />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(RANGE_LABELS) as DateRange[]).map((r) => (
              <SelectItem key={r} value={r}>
                {RANGE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {range === "custom" ? (
          <span className="inline-flex items-center gap-1">
            <Input type="date" className="h-9 w-36" aria-label="From" value={params.from ?? ""} onChange={(e) => setParam("from", e.target.value || undefined)} />
            <Input type="date" className="h-9 w-36" aria-label="To" value={params.to ?? ""} onChange={(e) => setParam("to", e.target.value || undefined)} />
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <Button size="icon" aria-label="List view" aria-pressed className="pointer-events-none">
            <List />
          </Button>
          <Button variant="secondary" size="icon" aria-label="Calendar view" onClick={onShowCalendar}>
            <CalendarDays />
          </Button>
          <Button variant="secondary" size="icon" aria-label="Grouped list" onClick={onShowGrouped} title="Group by due date, with subtasks">
            <LayoutList />
          </Button>
        </span>
      </div>

      <section aria-label="Activities" className="rounded-2xl border border-border bg-surface shadow-sm">
        {list.isError ? (
          <EmptyState title="Could not load activities" description={errorMessage(list.error)} />
        ) : list.isPending ? (
          <div className="p-3">
            <SkeletonRows rows={6} />
          </div>
        ) : list.items.length === 0 ? (
          <EmptyState
            icon={<CalendarDays />}
            title={followUps ? "No follow-ups waiting" : filtered ? "No activities match these filters" : "No activities yet"}
            description={canCreate && !filtered ? "Plan a task, call or meeting to get started." : undefined}
            action={canCreate && !filtered ? <Button size="sm" onClick={() => onCreate(kind ?? "task")}>New {KIND_LABELS[kind ?? "task"].singular.toLowerCase()}</Button> : undefined}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Activity</TableHead>
                <TableHead className="hidden md:table-cell">Related To</TableHead>
                <TableHead className="hidden lg:table-cell">Owner</TableHead>
                <TableHead>Due Date &amp; Time</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.items.map((a) => {
                const Icon = KIND_ICON[a.kind];
                const due = dueLabel(a);
                const status = displayStatus(a);
                const editable = canEditActivity(active, a);
                return (
                  <TableRow key={a.id}>
                    <TableCell>
                      <button type="button" onClick={() => onEdit(a)} className="inline-flex min-w-0 items-center gap-2.5 text-left font-semibold text-fg hover:text-primary">
                        <Icon className={cn("size-5 shrink-0", KIND_INK[a.kind])} aria-label={KIND_LABELS[a.kind].singular} />
                        <span className={cn("truncate", isDone(a) && "text-fg-muted line-through")}>{a.title}</span>
                      </button>
                    </TableCell>
                    <TableCell className="hidden max-w-48 md:table-cell">
                      <Related a={a} />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className="inline-flex items-center gap-2">
                        <Avatar name={a.owner?.display_name} size="sm" />
                        <span className="truncate">{a.owner?.display_name?.split(" ")[0] ?? "—"}</span>
                      </span>
                    </TableCell>
                    <TableCell className={cn("whitespace-nowrap", due.urgent ? "font-medium text-danger" : "text-fg")}>{due.text}</TableCell>
                    <TableCell>
                      <Badge className={status.className}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.title}`}>
                            <MoreVertical />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {editable ? <DropdownMenuItem onSelect={() => toggle.mutate(a)}>{isDone(a) ? "Reopen" : "Mark complete"}</DropdownMenuItem> : null}
                          <DropdownMenuItem onSelect={() => onEdit(a)}>{editable ? "Edit" : "View"}</DropdownMenuItem>
                          {editable ? <DropdownMenuItem onSelect={() => onEdit(a)}>Reschedule</DropdownMenuItem> : null}
                          {canDeleteActivity(active, a) ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-danger" onSelect={() => setDeleting(a)}>
                                Delete
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {list.items.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm text-fg-muted">
            <span>Showing 1–{list.items.length.toLocaleString()} activities</span>
            {list.hasMore ? (
              <Button variant="secondary" size="sm" onClick={() => list.loadMore()} loading={list.isLoadingMore}>
                Load more
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? null : setDeleting(null))}
        title="Delete this activity?"
        description={deleting ? `"${deleting.title}" is removed for everyone.` : undefined}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function OwnerFilter({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const members = useCursorList(queryKeys.members, listMembers);
  const options = members.isError ? [] : members.items.filter((m) => m.status === "active");
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className="h-9 w-36" aria-label="Owner">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All Owners</SelectItem>
        <SelectItem value="me">Me</SelectItem>
        {options.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.user.display_name || m.user.email}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
