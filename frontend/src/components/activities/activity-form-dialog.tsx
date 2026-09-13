"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CalendarDays, ListTodo, Phone } from "lucide-react";
import { KindFields, MoreDetails } from "@/components/activities/activity-form-fields";
import {
  activitySchema,
  defaultStart,
  defaultTitle,
  initialRelated,
  initialValues,
  toPayload,
  type ActivityFormValues,
  type FormDefaults,
  type FormMode,
  type RelatedState,
} from "@/components/activities/activity-form-schema";
import { KIND_LABELS, addMinutes, useInvalidateActivities } from "@/components/activities/activity-utils";
import { isVersionConflict } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { createActivity, getActivity, updateActivity } from "@/lib/api/crm";
import { ACTIVITY_KINDS, type Activity, type ActivityKind } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { scopeOf } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

export interface ActivityFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fix the kind (no switcher). Ignored when editing. */
  kind?: ActivityKind;
  /** Edit this activity instead of creating one. */
  activity?: Activity | null;
  /** "log" records something that already happened (completed on save, outcome shown, no reminder). */
  mode?: FormMode;
  /** Prefill linked records (shown as chips) and/or the start time. */
  defaults?: FormDefaults;
  onSaved?: (activity: Activity) => void;
}

const KIND_ICONS: Record<ActivityKind, React.ReactNode> = { task: <ListTodo />, call: <Phone />, meeting: <CalendarDays /> };

function titles(kind: ActivityKind, mode: FormMode, editing: boolean): { title: string; description: string; submit: string } {
  const noun = KIND_LABELS[kind].singular.toLowerCase();
  if (editing) return { title: `Edit ${noun}`, description: "Update the details of this activity.", submit: "Save changes" };
  if (mode === "log") {
    return {
      title: `Log ${noun}`,
      description: kind === "call" ? "Record a call that already happened. It is saved as completed." : "Record a meeting that already took place.",
      submit: `Log ${noun}`,
    };
  }
  if (kind === "task") return { title: "New task", description: "A title is enough; add a due date to see it on your list.", submit: "Create task" };
  return { title: `Schedule ${noun}`, description: `Put a ${noun} on the calendar. Link it to a contact or deal from More details.`, submit: `Schedule ${noun}` };
}

/** Create or edit a task, call or meeting. Pass `activity` to edit (its `version` is sent on save). */
export function ActivityFormDialog({ open, onOpenChange, kind: fixedKind, activity = null, mode = "schedule", defaults, onSaved }: ActivityFormDialogProps) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const showOwner = scopeOf(active, "activities.update") === "all";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = useInvalidateActivities();

  const [fresh, setFresh] = React.useState<Activity | null>(null);
  const existing = fresh ?? activity;
  const editing = existing !== null;
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [related, setRelated] = React.useState<RelatedState>({ contact: null, company: null, deal: null, attendees: [] });
  const [conflict, setConflict] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);

  const form = useForm<ActivityFormValues>({
    resolver: zodResolver(activitySchema),
    defaultValues: initialValues(fixedKind ?? "task", mode, null, defaults, active?.membership_id),
  });
  const kind = form.watch("kind");

  const load = React.useCallback(
    (record: Activity | null) => {
      form.reset(initialValues(record?.kind ?? fixedKind ?? "task", mode, record, defaults, active?.membership_id));
      setRelated(initialRelated(record, defaults));
      setFieldErrors({});
      setConflict(false);
    },
    [form, fixedKind, mode, defaults, active?.membership_id],
  );

  React.useEffect(() => {
    if (open) {
      setFresh(null);
      load(activity);
    }
    // Reset once per open; `defaults` identity may change on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activity]);

  const switchKind = (next: ActivityKind) => {
    if (next === kind) return;
    const values = form.getValues();
    const start = values.start_at || defaultStart(next, mode, defaults?.start_at);
    form.setValue("kind", next);
    if (!values.title || values.title === defaultTitle(kind, related.contact?.name)) form.setValue("title", defaultTitle(next, related.contact?.name));
    if (next !== "task") form.setValue("start_at", start);
    if (next === "meeting" && !values.end_at && start) form.setValue("end_at", addMinutes(start, 30));
    if (next === "call" && !values.duration_minutes) form.setValue("duration_minutes", "15");
    form.clearErrors();
  };

  const mutation = useMutation({
    mutationFn: (values: ActivityFormValues) => {
      const payload = toPayload(values, related, { mode, editing, includeOwner: showOwner });
      return existing ? updateActivity(existing.id, existing.version, payload) : createActivity(payload);
    },
    onSuccess: async (saved) => {
      await invalidate(saved);
      queryClient.setQueryData(crmKeys.activity(saved.id), saved);
      const noun = KIND_LABELS[saved.kind].singular;
      toast({
        tone: "success",
        title: editing ? `${noun} updated` : saved.status === "completed" ? `${noun} logged` : kind === "task" ? "Task created" : `${noun} scheduled`,
        description: saved.title,
      });
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      if (isVersionConflict(err)) {
        setConflict(true);
        toast({ tone: "error", title: "This activity was changed by someone else", description: "Reload the form to pick up the latest version." });
        return;
      }
      if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
        return;
      }
      toast({ tone: "error", title: `Could not save ${KIND_LABELS[kind].singular.toLowerCase()}`, description: errorMessage(err) });
    },
  });

  const reload = async () => {
    if (!existing) return;
    setReloading(true);
    try {
      const latest = await queryClient.fetchQuery({ queryKey: crmKeys.activity(existing.id), queryFn: () => getActivity(existing.id), staleTime: 0 });
      setFresh(latest);
      load(latest);
    } catch (err) {
      toast({ tone: "error", title: "Could not reload", description: errorMessage(err) });
    } finally {
      setReloading(false);
    }
  };

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    mutation.mutate(values);
  });

  const copy = titles(kind, mode, editing);
  const showSwitcher = !editing && !fixedKind;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          {showSwitcher ? (
            <div role="group" aria-label="Activity type" className="inline-flex h-8 w-fit items-center gap-0.5 rounded-sm bg-bg-subtle p-0.5">
              {ACTIVITY_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => switchKind(k)}
                  aria-pressed={kind === k}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
                    kind === k ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                  )}
                >
                  {KIND_ICONS[k]} {KIND_LABELS[k].singular}
                </button>
              ))}
            </div>
          ) : null}
          <FormError message={fieldErrors.non_field_errors ?? fieldErrors.version ?? fieldErrors.kind} />
          {conflict ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
              <span>This activity was changed by someone else. Reload to see their changes before saving.</span>
              <Button type="button" size="sm" variant="secondary" onClick={reload} loading={reloading}>
                Reload
              </Button>
            </div>
          ) : null}

          <KindFields
            form={form}
            kind={kind}
            mode={mode}
            editing={editing}
            errors={fieldErrors}
            disabled={mutation.isPending}
            related={related}
            onRelatedChange={(patch) => setRelated((r) => ({ ...r, ...patch }))}
          />
          <MoreDetails
            form={form}
            kind={kind}
            editing={editing}
            errors={fieldErrors}
            disabled={mutation.isPending}
            related={related}
            onRelatedChange={(patch) => setRelated((r) => ({ ...r, ...patch }))}
            showOwner={showOwner}
          />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
