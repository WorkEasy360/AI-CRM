import type { Deal } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse an ISO date or datetime as a local calendar day (date-only strings must not shift across time zones). */
export function localDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = DATE_ONLY.exec(value);
  const date = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole days from `now` to `value` (negative in the past); null when unparseable. */
export function daysUntil(value: string | null | undefined, now: Date = new Date()): number | null {
  const target = localDay(value);
  if (!target) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / DAY_MS);
}

/** "Today", "Tomorrow", "in 3 days", "2 weeks ago" — plain English, no locale surprises. */
export function relativeDayLabel(value: string | null | undefined, now: Date = new Date()): string {
  const diff = daysUntil(value, now);
  if (diff === null) return "";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const abs = Math.abs(diff);
  const [n, unit] = abs >= 60 ? [Math.round(abs / 30), "month"] : abs >= 14 ? [Math.round(abs / 7), "week"] : [abs, "day"];
  const text = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** An open deal whose expected close date has passed. */
export function isPastClose(deal: Pick<Deal, "status" | "expected_close_date">, now: Date = new Date()): boolean {
  if (deal.status !== "open") return false;
  const diff = daysUntil(deal.expected_close_date, now);
  return diff !== null && diff < 0;
}

/** Sum of the server-computed weighted values of the given cards, as a fixed 2-decimal string. */
export function weightedTotal(deals: Pick<Deal, "weighted_amount_base">[]): string {
  return deals.reduce((sum, d) => sum + Number(d.weighted_amount_base || 0), 0).toFixed(2);
}

/** Friendly copy for AI endpoints: they may answer 429 (quota), 503 (unavailable) or 422 (refused). */
export function aiErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 429) return "The AI quota is used up for now. Try again in a little while.";
    if (error.status === 503) return "The AI assistant is temporarily unavailable. Try again later.";
    if (error.status === 422) return "The AI could not work with this deal's content, so nothing was generated.";
    if (error.status === 403) return "You do not have access to the AI assistant.";
  }
  return errorMessage(error, "Something went wrong while contacting the AI assistant.");
}
