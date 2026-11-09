export type DueTone = "overdue" | "today" | "tomorrow" | "later";

/** Soft badge colours per tone, from the status tokens. */
export const DUE_TONE_CLASS: Record<DueTone, string> = {
  overdue: "bg-danger-soft text-danger",
  today: "bg-warning-soft text-warning",
  tomorrow: "bg-accent-soft text-accent",
  later: "bg-bg-subtle text-fg-muted",
};

const dayFormat = () => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * When a new follow-up defaults to: tomorrow at 10:00 on the viewer's clock, as the "YYYY-MM-DDTHH:mm" a
 * date-time field takes. An undated task is not a next step, so it must never be the path of least resistance.
 */
export function defaultFollowUpTime(now: Date = new Date()): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`;
}

/** "12 Nov" in the viewer's locale. */
export function formatDayMonth(value: string): string {
  return dayFormat().format(new Date(value));
}

/** How a date reads against today, on the viewer's clock: "Today", "Tomorrow", otherwise "19 Nov". */
export function dueLabel(value: string, now: Date = new Date()): { text: string; tone: DueTone } {
  const date = new Date(value);
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (days === 0) return { text: "Today", tone: "today" };
  if (days === 1) return { text: "Tomorrow", tone: "tomorrow" };
  return { text: formatDayMonth(value), tone: days < 0 ? "overdue" : "later" };
}
