"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Activity, ActivityKind, ActivityPriority, ActivityStatus } from "@/lib/api/crm-types";
import type { ActiveContext } from "@/lib/api/types";
import { crmKeys } from "@/lib/crm/keys";
import { scopeOf } from "@/lib/crm/permissions";

/* ------------------------------------------------------------------ labels */

export const KIND_LABELS: Record<ActivityKind, { singular: string; plural: string }> = {
  task: { singular: "Task", plural: "Tasks" },
  call: { singular: "Call", plural: "Calls" },
  meeting: { singular: "Meeting", plural: "Meetings" },
};

export const PRIORITY_LABELS: Record<ActivityPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
export const STATUS_LABELS: Record<ActivityStatus, string> = { open: "Open", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" };

export const REMINDER_OPTIONS: { value: string; label: string }[] = [
  { value: "none", label: "No reminder" },
  { value: "10", label: "10 minutes before" },
  { value: "30", label: "30 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "1440", label: "1 day before" },
];

/** Chip / badge colour per kind: task = slate, call = teal (accent), meeting = primary. */
export function kindColorClasses(kind: ActivityKind): string {
  switch (kind) {
    case "call":
      return "bg-accent-soft text-accent border-accent/30";
    case "meeting":
      return "bg-primary-soft text-primary border-primary/30";
    default:
      return "bg-bg-subtle text-fg-muted border-border";
  }
}

export function isDone(activity: Pick<Activity, "status">): boolean {
  return activity.status === "completed" || activity.status === "cancelled";
}

/* ------------------------------------------------------------------ dates */

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 with the browser's UTC offset, e.g. `2026-09-13T10:00:00+05:30` (never `Z`). */
export function toIsoWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(
    Math.floor(abs / 60),
  )}:${pad(abs % 60)}`;
}

/** `YYYY-MM-DD` in local time. */
export function toDateInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH:mm` in local time. */
export function toTimeInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `YYYY-MM-DDTHH:mm` for `<input type="datetime-local">`, in local time. */
export function toDateTimeInput(value: Date | string | null | undefined): string {
  const date = toDateInput(value);
  return date ? `${date}T${toTimeInput(value)}` : "";
}

/** Parse a `datetime-local` value (or a date plus optional time) into a local Date; null when empty/invalid. */
export function parseLocal(date: string, time = ""): Date | null {
  if (!date) return null;
  const [datePart, timePart] = date.includes("T") ? date.split("T") : [date, time];
  const [y, m, d] = (datePart ?? "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const [hh, mm] = (timePart || "00:00").split(":").map(Number);
  const out = new Date(y, m - 1, d, hh ?? 0, mm ?? 0, 0, 0);
  return Number.isNaN(out.getTime()) ? null : out;
}

/** Current local time rounded up to the next 5 minutes, as a datetime-local string. */
export function nowInput(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  const rounded = Math.ceil(d.getMinutes() / 5) * 5;
  d.setMinutes(rounded);
  return toDateTimeInput(d);
}

export function addMinutes(input: string, minutes: number): string {
  const d = parseLocal(input);
  if (!d) return "";
  return toDateTimeInput(new Date(d.getTime() + minutes * 60_000));
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "in 2 h", "3 d ago", "today", "tomorrow"… relative to now. */
export function relativeTime(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = date.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < minute) return "now";
  if (abs < hour) return rtf.format(Math.round(diffMs / minute), "minute");
  if (abs < day) return rtf.format(Math.round(diffMs / hour), "hour");
  const dayDiff = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / day);
  if (Math.abs(dayDiff) < 30) return rtf.format(dayDiff, "day");
  if (Math.abs(dayDiff) < 365) return rtf.format(Math.round(dayDiff / 30), "month");
  return rtf.format(Math.round(dayDiff / 365), "year");
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(d);
}

/* ------------------------------------------------------------------ permissions */

function inScope(active: ActiveContext | null | undefined, permission: string, activity: Pick<Activity, "owner">): boolean {
  const scope = scopeOf(active, permission);
  if (!scope) return false;
  // team scope: the API decides; show the control optimistically for visible activities.
  if (scope === "all" || scope === "team") return true;
  return Boolean(activity.owner) && activity.owner?.id === active?.membership_id;
}

/** Whether the actor may edit/complete/reopen this activity (mirrors the backend scope rules). */
export function canEditActivity(active: ActiveContext | null | undefined, activity: Pick<Activity, "owner">): boolean {
  return inScope(active, "activities.update", activity);
}

export function canDeleteActivity(active: ActiveContext | null | undefined, activity: Pick<Activity, "owner">): boolean {
  return inScope(active, "activities.delete", activity);
}

/* ------------------------------------------------------------------ cache */

/** Invalidate every query that can show an activity: lists, calendar, summary, timeline, linked records and the board. */
export function useInvalidateActivities() {
  const queryClient = useQueryClient();
  return React.useCallback(
    async (activity?: Pick<Activity, "contact" | "company" | "deal"> | null) => {
      const jobs: Promise<unknown>[] = [
        queryClient.invalidateQueries({ queryKey: ["crm", "activities"] }),
        queryClient.invalidateQueries({ queryKey: ["crm", "timeline"] }),
        queryClient.invalidateQueries({ queryKey: ["crm", "deals", "board"] }),
      ];
      if (activity?.contact) jobs.push(queryClient.invalidateQueries({ queryKey: crmKeys.record("contacts", activity.contact.id) }));
      if (activity?.company) jobs.push(queryClient.invalidateQueries({ queryKey: crmKeys.record("companies", activity.company.id) }));
      if (activity?.deal) jobs.push(queryClient.invalidateQueries({ queryKey: crmKeys.record("deals", activity.deal.id) }));
      await Promise.all(jobs);
    },
    [queryClient],
  );
}
