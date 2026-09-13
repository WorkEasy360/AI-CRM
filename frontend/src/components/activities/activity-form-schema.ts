import { z } from "zod";
import {
  addMinutes,
  browserTimezone,
  nowInput,
  parseLocal,
  toDateInput,
  toDateTimeInput,
  toIsoWithOffset,
  toTimeInput,
} from "@/components/activities/activity-utils";
import type { Activity, ActivityInput, ActivityKind, MembershipRef, NamedRef } from "@/lib/api/crm-types";
import { ACTIVITY_KINDS, ACTIVITY_PRIORITIES, ACTIVITY_STATUSES } from "@/lib/api/crm-types";

export type FormMode = "schedule" | "log";

export const NONE = "none";
const URL_RE = /^https?:\/\/\S+$/i;
const MAX_DURATION = 1440;

export const activitySchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS),
    title: z.string().trim().min(1, "Enter a title.").max(200, "Title is too long."),
    description: z.string().max(5000, "Notes are too long."),
    priority: z.enum(ACTIVITY_PRIORITIES),
    status: z.enum(ACTIVITY_STATUSES),
    due_date: z.string(),
    due_time: z.string(),
    start_at: z.string(),
    end_at: z.string(),
    all_day: z.boolean(),
    direction: z.enum(["inbound", "outbound"]),
    outcome: z.string(),
    duration_minutes: z.string().trim(),
    location: z.string().trim().max(255, "Location is too long."),
    meeting_url: z
      .string()
      .trim()
      .max(2000, "Link is too long.")
      .refine((v) => v === "" || URL_RE.test(v), "Enter a full link starting with http:// or https://."),
    reminder: z.string(),
    owner_id: z.string(),
    mark_done: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "task" && v.due_time && !v.due_date) {
      ctx.addIssue({ code: "custom", path: ["due_date"], message: "Pick a date for that time." });
    }
    if (v.kind === "call" && !v.start_at) {
      ctx.addIssue({ code: "custom", path: ["start_at"], message: "Choose when the call happens." });
    }
    if (v.kind === "call" && v.duration_minutes !== "") {
      const n = Number(v.duration_minutes);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DURATION) {
        ctx.addIssue({ code: "custom", path: ["duration_minutes"], message: `Enter 1 to ${MAX_DURATION} minutes.` });
      }
    }
    if (v.kind === "meeting") {
      if (!v.start_at) ctx.addIssue({ code: "custom", path: ["start_at"], message: "Choose when the meeting starts." });
      if (!v.all_day && v.start_at && v.end_at) {
        const start = parseLocal(v.start_at);
        const end = parseLocal(v.end_at);
        if (start && end && end < start) ctx.addIssue({ code: "custom", path: ["end_at"], message: "The meeting must end after it starts." });
      }
    }
  });

export type ActivityFormValues = z.infer<typeof activitySchema>;

export interface RelatedState {
  contact: NamedRef | null;
  company: NamedRef | null;
  deal: NamedRef | null;
  attendees: MembershipRef[];
}

export interface FormDefaults {
  contact?: { id: string; name: string } | null;
  company?: NamedRef | null;
  deal?: NamedRef | null;
  start_at?: string;
}

/** Start of the next full hour, for "schedule" defaults. */
function nextHourInput(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toDateTimeInput(d);
}

export function defaultTitle(kind: ActivityKind, contactName: string | undefined): string {
  if (!contactName) return "";
  if (kind === "call") return `Call with ${contactName}`;
  if (kind === "meeting") return `Meeting with ${contactName}`;
  return "";
}

export function defaultStart(kind: ActivityKind, mode: FormMode, preset?: string): string {
  if (preset) return toDateTimeInput(preset);
  if (kind === "task") return "";
  return mode === "log" ? nowInput() : nextHourInput();
}

export function initialValues(
  kind: ActivityKind,
  mode: FormMode,
  activity: Activity | null,
  defaults: FormDefaults | undefined,
  membershipId: string | undefined,
): ActivityFormValues {
  if (activity) {
    const isTask = activity.kind === "task";
    return {
      kind: activity.kind,
      title: activity.title,
      description: activity.description,
      priority: activity.priority,
      status: activity.status,
      due_date: isTask ? toDateInput(activity.start_at) : "",
      due_time: isTask && !activity.all_day ? toTimeInput(activity.start_at) : "",
      start_at: isTask ? "" : activity.all_day ? toDateInput(activity.start_at) : toDateTimeInput(activity.start_at),
      end_at: activity.kind === "meeting" && !activity.all_day ? toDateTimeInput(activity.end_at) : "",
      all_day: activity.all_day,
      direction: activity.direction === "inbound" ? "inbound" : "outbound",
      outcome: activity.outcome || NONE,
      duration_minutes: activity.duration_minutes ? String(activity.duration_minutes) : "",
      location: activity.location,
      meeting_url: activity.meeting_url,
      reminder: activity.reminder_minutes === null ? NONE : String(activity.reminder_minutes),
      owner_id: activity.owner?.id ?? membershipId ?? "",
      mark_done: false,
    };
  }
  const start = defaultStart(kind, mode, defaults?.start_at);
  return {
    kind,
    title: defaultTitle(kind, defaults?.contact?.name),
    description: "",
    priority: "normal",
    status: "open",
    due_date: kind === "task" && defaults?.start_at ? toDateInput(defaults.start_at) : "",
    due_time: kind === "task" && defaults?.start_at ? toTimeInput(defaults.start_at) : "",
    start_at: start,
    end_at: kind === "meeting" && start ? addMinutes(start, 30) : "",
    all_day: false,
    direction: "outbound",
    outcome: NONE,
    duration_minutes: kind === "call" ? "15" : "",
    location: "",
    meeting_url: "",
    reminder: mode === "log" ? NONE : "30",
    owner_id: membershipId ?? "",
    mark_done: false,
  };
}

export function initialRelated(activity: Activity | null, defaults: FormDefaults | undefined): RelatedState {
  if (activity) return { contact: activity.contact, company: activity.company, deal: activity.deal, attendees: activity.attendees };
  return { contact: defaults?.contact ?? null, company: defaults?.company ?? null, deal: defaults?.deal ?? null, attendees: [] };
}

function iso(input: string): string | null {
  const d = parseLocal(input);
  return d ? toIsoWithOffset(d) : null;
}

/** Build the request body. Only fields the kind accepts are sent (the API rejects the rest). */
export function toPayload(
  values: ActivityFormValues,
  related: RelatedState,
  options: { mode: FormMode; editing: boolean; includeOwner: boolean },
): ActivityInput {
  const payload: ActivityInput = {
    title: values.title,
    description: values.description,
    contact_id: related.contact?.id ?? null,
    company_id: related.company?.id ?? null,
    deal_id: related.deal?.id ?? null,
  };
  if (!options.editing) payload.kind = values.kind;
  if (options.includeOwner && values.owner_id) payload.owner_id = values.owner_id;
  if (options.editing) payload.status = values.status;

  if (values.kind === "task") {
    payload.priority = values.priority;
    if (values.due_date) {
      payload.start_at = iso(values.due_time ? `${values.due_date}T${values.due_time}` : values.due_date);
      payload.all_day = !values.due_time;
    } else {
      payload.start_at = null;
      payload.all_day = false;
    }
    if (!options.editing && values.mark_done) payload.completed = true;
  } else if (values.kind === "call") {
    payload.priority = values.priority;
    payload.start_at = iso(values.start_at);
    payload.direction = values.direction;
    payload.outcome = values.outcome === NONE ? "" : (values.outcome as ActivityInput["outcome"]);
    payload.duration_minutes = values.duration_minutes ? Number(values.duration_minutes) : null;
    if (options.mode === "log" && !options.editing) payload.completed = true;
  } else {
    payload.priority = values.priority;
    payload.all_day = values.all_day;
    payload.timezone = browserTimezone();
    if (values.all_day) {
      payload.start_at = iso(values.start_at.split("T")[0] ?? "");
      payload.end_at = null;
    } else {
      payload.start_at = iso(values.start_at);
      payload.end_at = values.end_at ? iso(values.end_at) : null;
    }
    payload.location = values.location;
    payload.meeting_url = values.meeting_url;
    payload.attendee_ids = related.attendees.map((a) => a.id);
    if (options.mode === "log" && !options.editing) {
      payload.completed = true;
      payload.reminder_minutes = null;
    } else {
      payload.reminder_minutes = values.reminder === NONE ? null : Number(values.reminder);
    }
  }
  return payload;
}
