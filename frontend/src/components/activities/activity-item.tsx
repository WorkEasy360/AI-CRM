"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Building2, CalendarDays, Handshake, ListChecks, ListPlus, ListTodo, MoreHorizontal, Pencil, Phone, Repeat, RotateCcw, Trash2, User } from "lucide-react";
import { ActivityFormDialog } from "@/components/activities/activity-form-dialog";
import { canDeleteActivity, canEditActivity, formatTime, isDone, kindColorClasses, PRIORITY_LABELS, relativeTime, STATUS_LABELS, useInvalidateActivities } from "@/components/activities/activity-utils";
import { describeRrule } from "@/components/activities/recurrence";
import { SubtaskPanel } from "@/components/activities/subtasks";
import { isVersionConflict } from "@/components/crm/use-record-mutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { completeActivity, deleteActivity, getActivity, reopenActivity } from "@/lib/api/crm";
import { CALL_OUTCOME_LABELS, CALL_OUTCOMES, type Activity, type ActivityKind, type CallOutcome } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn, formatDate, formatDateTime } from "@/lib/utils";

/* ------------------------------------------------------------------ mutation hooks */

function useActivityToast() {
  const { toast } = useToast();
  return (title: string) => (err: unknown) =>
    toast({
      tone: "error",
      title,
      description: isVersionConflict(err) ? "It was changed by someone else. Refresh the list and try again." : errorMessage(err),
    });
}

export function useCompleteActivity() {
  const invalidate = useInvalidateActivities();
  const { toast } = useToast();
  const fail = useActivityToast();
  return useMutation({
    mutationFn: ({ activity, outcome, note }: { activity: Activity; outcome?: CallOutcome; note?: string }) =>
      completeActivity(activity.id, activity.version, { outcome, note: note || undefined }),
    onSuccess: async (saved) => {
      await invalidate(saved);
      toast({ tone: "success", title: "Marked as done", description: saved.title });
    },
    onError: fail("Could not complete"),
  });
}

export function useReopenActivity() {
  const invalidate = useInvalidateActivities();
  const { toast } = useToast();
  const fail = useActivityToast();
  return useMutation({
    mutationFn: (activity: Activity) => reopenActivity(activity.id, activity.version),
    onSuccess: async (saved) => {
      await invalidate(saved);
      toast({ tone: "success", title: "Reopened", description: saved.title });
    },
    onError: fail("Could not reopen"),
  });
}

export function useDeleteActivity() {
  const invalidate = useInvalidateActivities();
  const { toast } = useToast();
  const fail = useActivityToast();
  return useMutation({
    mutationFn: (activity: Activity) => deleteActivity(activity.id),
    onSuccess: async (_data, activity) => {
      await invalidate(activity);
      toast({ tone: "success", title: "Deleted", description: activity.title });
    },
    onError: fail("Could not delete"),
  });
}

/* ------------------------------------------------------------------ presentation */

export function KindIcon({ kind, className }: { kind: ActivityKind; className?: string }) {
  const cls = cn("size-4", className);
  if (kind === "call") return <Phone className={cls} aria-hidden />;
  if (kind === "meeting") return <CalendarDays className={cls} aria-hidden />;
  return <ListTodo className={cls} aria-hidden />;
}

function whenLabel(activity: Activity): { text: string; title: string } | null {
  if (!activity.start_at) return null;
  if (activity.all_day) return { text: `${formatDate(activity.start_at)} · ${relativeTime(activity.start_at)}`, title: formatDate(activity.start_at) };
  const absolute = formatDateTime(activity.start_at);
  const end = activity.kind === "meeting" && activity.end_at ? `–${formatTime(activity.end_at)}` : "";
  return { text: `${absolute}${end} · ${relativeTime(activity.start_at)}`, title: absolute };
}

/** Outcome prompt shown when completing a call that has none yet. */
function OutcomeDialog({ activity, open, onOpenChange, onConfirm, loading }: { activity: Activity; open: boolean; onOpenChange: (o: boolean) => void; onConfirm: (outcome: CallOutcome, note: string) => void; loading: boolean }) {
  const [outcome, setOutcome] = React.useState<CallOutcome>("connected");
  const [note, setNote] = React.useState("");
  const id = React.useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>How did the call go?</DialogTitle>
          <DialogDescription>{activity.title}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-outcome`}>Outcome</Label>
            <Select value={outcome} onValueChange={(v) => setOutcome(v as CallOutcome)}>
              <SelectTrigger id={`${id}-outcome`} className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALL_OUTCOMES.map((o) => (
                  <SelectItem key={o} value={o}>
                    {CALL_OUTCOME_LABELS[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-note`}>Note (optional)</Label>
            <Textarea id={`${id}-note`} rows={2} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-14" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(outcome, note)} loading={loading}>
            Mark as done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ActivitySelection {
  selected: boolean;
  onToggle: () => void;
}

/**
 * One activity row: complete checkbox, kind icon, title, badges, related record links, when, and a
 * menu with edit / reopen / delete. `compact` drops the owner and tightens spacing for record pages.
 * Tasks show their subtask progress and expand to tick / add subtasks. With `selection` the leading
 * checkbox selects the row for bulk actions instead of completing it.
 */
export function ActivityItem({
  activity,
  onChanged,
  compact = false,
  selection,
}: {
  activity: Activity;
  onChanged?: (activity: Activity | null) => void;
  compact?: boolean;
  selection?: ActivitySelection;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const editable = canEditActivity(active, activity);
  const deletable = canDeleteActivity(active, activity);
  const complete = useCompleteActivity();
  const reopen = useReopenActivity();
  const remove = useDeleteActivity();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState(false);
  // An occurrence of a repeating event carries the occurrence's times; edits go to the event itself.
  const [series, setSeries] = React.useState<Activity | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [askOutcome, setAskOutcome] = React.useState(false);
  const [subtasks, setSubtasks] = React.useState<"closed" | "open" | "add">("closed");

  const done = isDone(activity);
  const busy = complete.isPending || reopen.isPending || remove.isPending;
  const when = whenLabel(activity);
  const occurrence = Boolean(activity.occurrence_of);
  const repeat = describeRrule(activity.recurrence);
  const hasSubtasks = activity.kind === "task" && !activity.parent_id;
  const canAddSubtask = hasSubtasks && editable && can(active, "activities.create");

  const startEdit = async () => {
    const id = activity.occurrence_of;
    if (!id) {
      setEditing(true);
      return;
    }
    try {
      setSeries(await queryClient.fetchQuery({ queryKey: crmKeys.activity(id), queryFn: () => getActivity(id), staleTime: 0 }));
      setEditing(true);
    } catch (err) {
      toast({ tone: "error", title: "Could not open this event", description: errorMessage(err) });
    }
  };

  const toggle = () => {
    if (done) {
      reopen.mutate(activity, { onSuccess: (saved) => onChanged?.(saved) });
      return;
    }
    if (activity.kind === "call" && !activity.outcome) {
      setAskOutcome(true);
      return;
    }
    complete.mutate({ activity }, { onSuccess: (saved) => onChanged?.(saved) });
  };

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-border bg-surface text-sm",
        compact ? "px-2.5 py-1.5" : "px-3 py-2",
        done && "bg-surface-sunken",
        selection?.selected && "border-primary/40 bg-primary-soft",
      )}
      data-testid={`activity-${activity.occurrence_key ?? activity.id}`}
    >
      {selection ? (
        <input
          type="checkbox"
          aria-label={`Select ${activity.title}`}
          checked={selection.selected}
          onChange={selection.onToggle}
          className="mt-1 size-4 shrink-0 accent-[var(--kl-primary)]"
        />
      ) : (
        <input
          type="checkbox"
          aria-label={done ? `Reopen ${activity.title}` : `Mark ${activity.title} as done`}
          checked={done}
          disabled={!editable || busy || occurrence}
          onChange={toggle}
          className="mt-1 size-4 shrink-0 accent-[var(--kl-primary)] disabled:opacity-50"
        />
      )}
      <span className={cn("mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm border", kindColorClasses(activity.kind))}>
        <KindIcon kind={activity.kind} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("font-medium", done && "text-fg-muted line-through")}>{activity.title}</span>
          {activity.status !== "open" && activity.status !== "completed" ? <Badge variant={activity.status === "cancelled" ? "neutral" : "primary"}>{STATUS_LABELS[activity.status]}</Badge> : null}
          {activity.priority === "high" || activity.priority === "urgent" ? (
            <Badge variant={activity.priority === "urgent" ? "danger" : "warning"}>{PRIORITY_LABELS[activity.priority]}</Badge>
          ) : null}
          {activity.kind === "call" && activity.direction ? (
            <Badge variant="outline" className="gap-0.5">
              {activity.direction === "inbound" ? <ArrowDownLeft className="size-3" aria-hidden /> : <ArrowUpRight className="size-3" aria-hidden />}
              {activity.direction === "inbound" ? "Inbound" : "Outbound"}
            </Badge>
          ) : null}
          {activity.kind === "call" && activity.outcome ? <Badge variant="accent">{CALL_OUTCOME_LABELS[activity.outcome]}</Badge> : null}
          {hasSubtasks && activity.subtask_count > 0 ? (
            <button
              type="button"
              onClick={() => setSubtasks((s) => (s === "closed" ? "open" : "closed"))}
              aria-expanded={subtasks !== "closed"}
              aria-label={`Subtasks: ${activity.subtasks_done} of ${activity.subtask_count} done`}
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-xs tabular-nums transition-colors hover:bg-bg-subtle",
                activity.subtasks_done === activity.subtask_count ? "border-success/30 text-success" : "border-border text-fg-muted",
              )}
            >
              <ListChecks className="size-3" aria-hidden />
              {activity.subtasks_done}/{activity.subtask_count}
            </button>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted">
          {when ? (
            <span className={cn(activity.is_overdue && "font-medium text-danger")} title={when.title}>
              {activity.is_overdue ? "Overdue · " : ""}
              {when.text}
            </span>
          ) : activity.kind === "task" ? (
            <span>No due date</span>
          ) : null}
          {repeat ? (
            <span className="inline-flex items-center gap-1" title={repeat}>
              <Repeat className="size-3" aria-hidden /> {repeat}
            </span>
          ) : null}
          {activity.parent_id ? <span className="text-fg-subtle">Subtask</span> : null}
          {activity.contact ? (
            <Link prefetch={false} href={`/contacts/${encodeURIComponent(activity.contact.id)}`} className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              <User className="size-3" aria-hidden /> {activity.contact.name}
            </Link>
          ) : null}
          {activity.deal ? (
            <Link prefetch={false} href={`/deals/${encodeURIComponent(activity.deal.id)}`} className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              <Handshake className="size-3" aria-hidden /> {activity.deal.name}
            </Link>
          ) : null}
          {activity.company ? (
            <Link prefetch={false} href={`/companies/${encodeURIComponent(activity.company.id)}`} className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              <Building2 className="size-3" aria-hidden /> {activity.company.name}
            </Link>
          ) : null}
          {!compact && activity.owner ? <span className="text-fg-subtle">{activity.owner.display_name}</span> : null}
        </div>
        {hasSubtasks && subtasks !== "closed" ? <SubtaskPanel parent={activity} canAdd={canAddSubtask} autoFocus={subtasks === "add"} /> : null}
      </div>
      {editable || deletable ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${activity.title}`} className="-my-1 -mr-1 size-7">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {editable ? (
              <>
                <DropdownMenuItem onSelect={() => void startEdit()}>
                  <Pencil /> {occurrence ? "Edit series" : "Edit"}
                </DropdownMenuItem>
                {occurrence ? null : (
                  <DropdownMenuItem onSelect={toggle}>
                    {done ? (
                      <>
                        <RotateCcw /> Reopen
                      </>
                    ) : (
                      <>
                        <ListTodo /> Mark as done
                      </>
                    )}
                  </DropdownMenuItem>
                )}
                {canAddSubtask ? (
                  <DropdownMenuItem onSelect={() => setSubtasks("add")}>
                    <ListPlus /> Add subtask
                  </DropdownMenuItem>
                ) : null}
              </>
            ) : null}
            {deletable ? (
              <>
                {editable ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {editing ? (
        <ActivityFormDialog
          open={editing}
          onOpenChange={(open) => {
            setEditing(open);
            if (!open) setSeries(null);
          }}
          activity={series ?? activity}
          onSaved={(saved) => onChanged?.(saved)}
        />
      ) : null}
      {askOutcome ? (
        <OutcomeDialog
          activity={activity}
          open={askOutcome}
          onOpenChange={setAskOutcome}
          loading={complete.isPending}
          onConfirm={(outcome, note) =>
            complete.mutate(
              { activity, outcome, note },
              {
                onSuccess: (saved) => {
                  setAskOutcome(false);
                  onChanged?.(saved);
                },
              },
            )
          }
        />
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={activity.recurrence ? `Delete this repeating ${activity.kind === "meeting" ? "event" : activity.kind}?` : `Delete this ${activity.kind}?`}
        description={
          activity.recurrence
            ? "Every occurrence is removed from the calendar and the record's timeline. This cannot be undone."
            : "It is removed from the calendar and the record's timeline. This cannot be undone."
        }
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(activity.occurrence_of ? { ...activity, id: activity.occurrence_of } : activity, {
            onSuccess: () => {
              setDeleting(false);
              onChanged?.(null);
            },
          })
        }
      />
    </div>
  );
}
