"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { canEditActivity, isDone, useInvalidateActivities } from "@/components/activities/activity-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { completeActivity, createActivity, listActivities, reopenActivity } from "@/lib/api/crm";
import type { Activity, ListParams } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn, formatDate } from "@/lib/utils";

/** Mirrors the API limit (apps.activities.services.MAX_SUBTASKS). */
export const MAX_SUBTASKS = 50;

function SubtaskRow({ subtask }: { subtask: Activity }) {
  const { data: session } = useSession();
  const editable = canEditActivity(session?.active, subtask);
  const invalidate = useInvalidateActivities();
  const { toast } = useToast();
  const done = isDone(subtask);
  const toggle = useMutation({
    mutationFn: () => (done ? reopenActivity(subtask.id, subtask.version) : completeActivity(subtask.id, subtask.version)),
    onSuccess: (saved) => invalidate(saved),
    onError: (err) => toast({ tone: "error", title: done ? "Could not reopen" : "Could not complete", description: errorMessage(err) }),
  });
  return (
    <li className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        aria-label={done ? `Reopen ${subtask.title}` : `Mark ${subtask.title} as done`}
        checked={done}
        disabled={!editable || toggle.isPending}
        onChange={() => toggle.mutate()}
        className="size-3.5 shrink-0 accent-[var(--kl-primary)] disabled:opacity-50"
      />
      <span className={cn("min-w-0 flex-1 truncate", done && "text-fg-muted line-through")}>{subtask.title}</span>
      {subtask.start_at && !done ? <span className={cn("shrink-0 text-xs", subtask.is_overdue ? "text-danger" : "text-fg-subtle")}>{formatDate(subtask.start_at)}</span> : null}
    </li>
  );
}

/** Subtasks of one task: tick them off, add more (one level deep, the API caps the count). */
export function SubtaskPanel({ parent, canAdd, autoFocus = false }: { parent: Activity; canAdd: boolean; autoFocus?: boolean }) {
  const params = React.useMemo<ListParams>(() => ({ parent: parent.id }), [parent.id]);
  const list = useCursorList<Activity>(crmKeys.activities(params), (cursor) => listActivities(params, cursor));
  const invalidate = useInvalidateActivities();
  const { toast } = useToast();
  const [title, setTitle] = React.useState("");

  const add = useMutation({
    mutationFn: (value: string) => createActivity({ kind: "task", title: value, parent_id: parent.id }),
    onSuccess: async (saved) => {
      setTitle("");
      await invalidate(saved);
    },
    onError: (err) => toast({ tone: "error", title: "Could not add subtask", description: errorMessage(err) }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = title.trim();
    if (value && !add.isPending) add.mutate(value);
  };
  const full = Math.max(parent.subtask_count, list.items.length) >= MAX_SUBTASKS;

  return (
    <div className="mt-2 grid gap-1.5 border-l border-border pl-3" aria-label={`Subtasks of ${parent.title}`} role="group">
      {list.isPending ? (
        <span className="text-xs text-fg-subtle">Loading subtasks…</span>
      ) : list.isError ? (
        <span className="text-xs text-danger">{errorMessage(list.error)}</span>
      ) : list.items.length > 0 ? (
        <ul className="grid gap-1">
          {list.items.map((s) => (
            <SubtaskRow key={s.id} subtask={s} />
          ))}
        </ul>
      ) : !canAdd ? (
        <span className="text-xs text-fg-subtle">No subtasks.</span>
      ) : null}
      {list.hasMore ? (
        <Button variant="link" size="sm" className="h-auto w-fit p-0 text-xs" onClick={() => list.loadMore()} loading={list.isLoadingMore}>
          Show more
        </Button>
      ) : null}
      {canAdd && !full ? (
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <Input
            aria-label="New subtask"
            placeholder="Add a subtask"
            value={title}
            maxLength={200}
            autoFocus={autoFocus}
            onChange={(e) => setTitle(e.target.value)}
            disabled={add.isPending}
            className="h-7 text-sm"
          />
          <Button type="submit" variant="secondary" size="sm" className="h-7" disabled={!title.trim()} loading={add.isPending} aria-label="Add subtask">
            <Plus /> Add
          </Button>
        </form>
      ) : null}
    </div>
  );
}
