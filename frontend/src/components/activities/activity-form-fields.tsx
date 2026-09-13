"use client";

import * as React from "react";
import type { UseFormReturn } from "react-hook-form";
import { ChevronDown, ChevronRight } from "lucide-react";
import { addMinutes } from "@/components/activities/activity-utils";
import { PRIORITY_LABELS, REMINDER_OPTIONS, STATUS_LABELS } from "@/components/activities/activity-utils";
import { NONE, type ActivityFormValues, type FormMode, type RelatedState } from "@/components/activities/activity-form-schema";
import { MemberMultiSelect, RecordChip, RecordPicker } from "@/components/activities/pickers";
import { OwnerSelect } from "@/components/crm/owner-select";
import { FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ACTIVITY_PRIORITIES, ACTIVITY_STATUSES, CALL_OUTCOME_LABELS, CALL_OUTCOMES, type ActivityKind } from "@/lib/api/crm-types";
import { cn } from "@/lib/utils";

interface FieldsProps {
  form: UseFormReturn<ActivityFormValues>;
  kind: ActivityKind;
  mode: FormMode;
  editing: boolean;
  errors: Record<string, string>;
  disabled: boolean;
  related: RelatedState;
  onRelatedChange: (patch: Partial<RelatedState>) => void;
  showOwner: boolean;
}

function SelectField({
  form,
  name,
  label,
  options,
  error,
  disabled,
  className,
}: {
  form: UseFormReturn<ActivityFormValues>;
  name: "priority" | "direction" | "outcome" | "reminder" | "status";
  label: string;
  options: { value: string; label: string }[];
  error?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <FormField control={form.control} name={name} label={label} serverError={error} className={className}>
      {(field) => (
        <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
          <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]} className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormField>
  );
}

const PRIORITY_OPTIONS = ACTIVITY_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
const STATUS_OPTIONS = ACTIVITY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }));
const OUTCOME_OPTIONS = [{ value: NONE, label: "Not recorded" }, ...CALL_OUTCOMES.map((o) => ({ value: o, label: CALL_OUTCOME_LABELS[o] }))];
const DIRECTION_OPTIONS = [
  { value: "outbound", label: "Outbound" },
  { value: "inbound", label: "Inbound" },
];

/** Kind-specific quick fields shown above the fold. */
export function KindFields({ form, kind, mode, editing, errors, disabled, related, onRelatedChange }: Omit<FieldsProps, "showOwner">) {
  const allDay = form.watch("all_day");
  const textField = (name: "title" | "location" | "meeting_url" | "duration_minutes", label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, className?: string) => (
    <FormField control={form.control} name={name} label={label} serverError={errors[name]} className={className}>
      {(field) => <Input {...field} {...props} className="h-8" disabled={disabled} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
    </FormField>
  );
  const dateField = (name: "due_date" | "due_time" | "start_at" | "end_at", label: string, type: "date" | "time" | "datetime-local", onChange?: (v: string) => void) => (
    <FormField control={form.control} name={name} label={label} serverError={errors[name]}>
      {(field) => (
        <Input
          {...field}
          type={type}
          className="h-8"
          disabled={disabled}
          value={field.value}
          onChange={(e) => {
            field.onChange(e.target.value);
            onChange?.(e.target.value);
          }}
        />
      )}
    </FormField>
  );

  return (
    <div className="grid gap-4">
      {textField("title", "Title", { autoFocus: true, maxLength: 200, autoComplete: "off", placeholder: kind === "task" ? "What needs doing?" : undefined })}

      {kind === "task" ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {dateField("due_date", "Due date", "date")}
          {dateField("due_time", "Time", "time")}
          <SelectField form={form} name="priority" label="Priority" options={PRIORITY_OPTIONS} error={errors.priority} disabled={disabled} />
        </div>
      ) : null}

      {kind === "call" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {dateField("start_at", "When", "datetime-local")}
            <SelectField form={form} name="direction" label="Direction" options={DIRECTION_OPTIONS} error={errors.direction} disabled={disabled} />
            {textField("duration_minutes", "Duration (minutes)", { type: "number", min: 1, max: 1440, inputMode: "numeric" })}
          </div>
          {mode === "log" || editing ? (
            <SelectField form={form} name="outcome" label="Outcome" options={OUTCOME_OPTIONS} error={errors.outcome} disabled={disabled} className="sm:max-w-xs" />
          ) : null}
          <FormField control={form.control} name="description" label="Notes" serverError={errors.description}>
            {({ invalid: _invalid, ...field }) => (
              <Textarea {...field} rows={3} maxLength={5000} disabled={disabled} placeholder="What was discussed, next steps…" value={field.value} onChange={(e) => field.onChange(e.target.value)} />
            )}
          </FormField>
        </>
      ) : null}

      {kind === "meeting" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
            {allDay
              ? dateField("start_at", "Date", "date")
              : dateField("start_at", "Starts", "datetime-local", (v) => {
                  if (v) form.setValue("end_at", addMinutes(v, 30), { shouldValidate: false });
                })}
            {allDay ? <div /> : dateField("end_at", "Ends", "datetime-local")}
            <FormField control={form.control} name="all_day" label="All day">
              {(field) => (
                <div className="flex h-8 items-center">
                  <Switch
                    id={field.id}
                    checked={field.value}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      field.onChange(checked);
                      const start = form.getValues("start_at");
                      // datetime-local -> date and back; keep the day, drop/restore the time part.
                      if (checked && start.includes("T")) form.setValue("start_at", start.split("T")[0] ?? "");
                      if (!checked && start && !start.includes("T")) {
                        form.setValue("start_at", `${start}T09:00`);
                        form.setValue("end_at", `${start}T09:30`);
                      }
                    }}
                  />
                </div>
              )}
            </FormField>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activity-attendees">Attendees</Label>
            <MemberMultiSelect id="activity-attendees" value={related.attendees} onChange={(attendees) => onRelatedChange({ attendees })} disabled={disabled} />
            {errors.attendee_ids ? <p role="alert" className="text-xs text-danger">{errors.attendee_ids}</p> : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("location", "Location", { maxLength: 255, placeholder: "Office, address or room" })}
            {textField("meeting_url", "Meeting link", { type: "url", maxLength: 2000, placeholder: "https://…", inputMode: "url" })}
          </div>
          {mode !== "log" ? (
            <SelectField form={form} name="reminder" label="Reminder" options={REMINDER_OPTIONS} error={errors.reminder_minutes} disabled={disabled} className="sm:max-w-xs" />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Progressive-disclosure section: description, related records, owner, status. */
export function MoreDetails({ form, kind, editing, errors, disabled, related, onRelatedChange, showOwner }: Omit<FieldsProps, "mode">) {
  const hasLinks = Boolean(related.contact || related.company || related.deal);
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="grid gap-3">
      {!open && hasLinks ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Linked records">
          {related.contact ? <RecordChip label="Contact" name={related.contact.name} /> : null}
          {related.company ? <RecordChip label="Company" name={related.company.name} /> : null}
          {related.deal ? <RecordChip label="Deal" name={related.deal.name} /> : null}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
      >
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />} More details
      </button>
      <div id={id} hidden={!open} className={cn("grid gap-4 rounded-sm border border-border bg-surface-sunken p-3", !open && "hidden")}>
        {kind !== "call" ? (
          <FormField control={form.control} name="description" label="Description" serverError={errors.description}>
            {({ invalid: _invalid, ...field }) => (
              <Textarea {...field} rows={3} maxLength={5000} disabled={disabled} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
            )}
          </FormField>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-contact`}>Contact</Label>
            <RecordPicker id={`${id}-contact`} entity="contact" value={related.contact} onChange={(contact) => onRelatedChange({ contact })} disabled={disabled} />
            {errors.contact_id ? <p role="alert" className="text-xs text-danger">{errors.contact_id}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-company`}>Company</Label>
            <RecordPicker id={`${id}-company`} entity="company" value={related.company} onChange={(company) => onRelatedChange({ company })} disabled={disabled} />
            {errors.company_id ? <p role="alert" className="text-xs text-danger">{errors.company_id}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-deal`}>Deal</Label>
            <RecordPicker id={`${id}-deal`} entity="deal" value={related.deal} onChange={(deal) => onRelatedChange({ deal })} disabled={disabled} />
            {errors.deal_id ? <p role="alert" className="text-xs text-danger">{errors.deal_id}</p> : null}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {kind !== "task" ? <SelectField form={form} name="priority" label="Priority" options={PRIORITY_OPTIONS} error={errors.priority} disabled={disabled} /> : null}
          {showOwner ? (
            <FormField control={form.control} name="owner_id" label="Owner" serverError={errors.owner_id}>
              {(field) => <OwnerSelect id={field.id} value={field.value} onChange={field.onChange} ariaInvalid={field.invalid} disabled={disabled} />}
            </FormField>
          ) : null}
          {editing ? <SelectField form={form} name="status" label="Status" options={STATUS_OPTIONS} error={errors.status} disabled={disabled} /> : null}
          {kind === "task" && !editing ? (
            <FormField control={form.control} name="mark_done" label="Mark as done">
              {(field) => (
                <div className="flex h-8 items-center">
                  <Switch id={field.id} checked={field.value} onCheckedChange={field.onChange} disabled={disabled} />
                </div>
              )}
            </FormField>
          ) : null}
        </div>
      </div>
    </div>
  );
}
