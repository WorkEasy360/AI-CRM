"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Building2, CalendarDays, Handshake, ListTodo, MoreHorizontal, Pencil, Phone, RotateCcw, Trash2, User } from "lucide-react";
import { ActivityFormDialog } from "@/components/activities/activity-form-dialog";
import { canDeleteActivity, canEditActivity, formatTime, isDone, kindColorClasses, PRIORITY_LABELS, relativeTime, STATUS_LABELS, useInvalidateActivities } from "@/components/activities/activity-utils";
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
import { completeActivity, deleteActivity, reopenActivity } from "@/lib/api/crm";
import { CALL_OUTCOME_LABELS, CALL_OUTCOMES, type Activity, type ActivityKind, type CallOutcome } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
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

/**
 * One activity row: complete checkbox, kind icon, title, badges, related record links, when, and a
 * menu with edit / reopen / delete. `compact` drops the owner and tightens spacing for record pages.
 */
export function ActivityItem({ activity, onChanged, compact = false }: { activity: Activity; onChanged?: (activity: Activity | null) => void; compact?: boolean }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const editable = canEditActivity(active, activity);
  const deletable = canDeleteActivity(active, activity);
  const complete = useCompleteActivity();
  const reopen = useReopenActivity();
  const remove = useDeleteActivity();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [askOutcome, setAskOutcome] = React.useState(false);

  const done = isDone(activity);
  const busy = complete.isPending || reopen.isPending || remove.isPending;
  const when = whenLabel(activity);

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
    <div className={cn("flex items-start gap-2.5 rounded-md border border-border bg-surface text-sm", compact ? "px-2.5 py-1.5" : "px-3 py-2", done && "bg-surface-sunken")} data-testid={`activity-${activity.id}`}>
      <input
        type="checkbox"
        aria-label={done ? `Reopen ${activity.title}` : `Mark ${activity.title} as done`}
        checked={done}
        disabled={!editable || busy}
        onChange={toggle}
        className="mt-1 size-4 shrink-0 accent-[var(--kl-primary)] disabled:opacity-50"
      />
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
          {activity.contact ? (
            <Link href={`/contacts/${encodeURIComponent(activity.contact.id)}`} className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              <User className="size-3" aria-hidden /> {activity.contact.name}
            </Link>
          ) : null}
          {activity.deal ? (
            <Link href={`/deals/${encodeURIComponent(activity.deal.id)}`} className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              <Handshake className="size-3" aria-hidden /> {activity.deal.name}
            </Link>
          ) : null}
          {activity.company ? (
            <Link href={`/companies/${encodeURIComponent(activity.company.id)}`} className="inline-flex items-center gap-1 hover:text-fg hover:underline">
              <Building2 className="size-3" aria-hidden /> {activity.company.name}
            </Link>
          ) : null}
          {!compact && activity.owner ? <span className="text-fg-subtle">{activity.owner.display_name}</span> : null}
        </div>
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
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
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

      {editing ? <ActivityFormDialog open={editing} onOpenChange={setEditing} activity={activity} onSaved={(saved) => onChanged?.(saved)} /> : null}
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
        title={`Delete this ${activity.kind}?`}
        description="It is removed from the calendar and the record's timeline. This cannot be undone."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(activity, {
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
