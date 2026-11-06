/**
 * The small subset of RFC 5545 RRULE the Repeat control edits: FREQ, INTERVAL, BYDAY (plain weekdays),
 * COUNT or UNTIL. Any other rule (BYMONTHDAY, BYSETPOS, "1MO"…) parses as `custom` and is kept as-is.
 */

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, { short: string; long: string }> = {
  MO: { short: "M", long: "Mon" },
  TU: { short: "T", long: "Tue" },
  WE: { short: "W", long: "Wed" },
  TH: { short: "T", long: "Thu" },
  FR: { short: "F", long: "Fri" },
  SA: { short: "S", long: "Sat" },
  SU: { short: "S", long: "Sun" },
};

export type RepeatFreq = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
export type RepeatEnd = "never" | "count" | "until";

export interface RepeatRule {
  freq: RepeatFreq;
  interval: number;
  days: Weekday[];
  end: RepeatEnd;
  count: number;
  /** `YYYY-MM-DD`, local date of the last occurrence. */
  until: string;
  /** The original rule when `freq` is "custom". */
  raw: string;
}

export const MAX_COUNT = 1000;
export const MAX_INTERVAL = 366;

export const NO_REPEAT: RepeatRule = { freq: "none", interval: 1, days: [], end: "never", count: 10, until: "", raw: "" };

const FREQS: Record<string, RepeatFreq> = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" };
const SIMPLE_PARTS = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]);

const pad = (n: number) => String(n).padStart(2, "0");

/** Weekday code of a JS Date (local time). */
export function weekdayOf(date: Date): Weekday {
  return WEEKDAYS[(date.getDay() + 6) % 7]!;
}

/** `YYYY-MM-DD` (local) -> `UNTIL` value: the end of that local day, in UTC (the API needs UTC with aware starts). */
function untilValue(date: string): string | null {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const end = new Date(y, m - 1, d, 23, 59, 59);
  if (Number.isNaN(end.getTime())) return null;
  return `${end.getUTCFullYear()}${pad(end.getUTCMonth() + 1)}${pad(end.getUTCDate())}T${pad(end.getUTCHours())}${pad(end.getUTCMinutes())}${pad(end.getUTCSeconds())}Z`;
}

/** `UNTIL` value (`YYYYMMDD`, `YYYYMMDDTHHMMSS` or with `Z`) -> local `YYYY-MM-DD`. */
function untilDate(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (z) {
    const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  }
  return `${y}-${mo}-${d}`;
}

/** Parse an RRULE string ("" = does not repeat). Rules the control cannot show come back as `custom`. */
export function parseRrule(value: string | null | undefined): RepeatRule {
  let rule = (value ?? "").trim();
  if (!rule) return { ...NO_REPEAT };
  if (/^RRULE:/i.test(rule)) rule = rule.slice(6);
  const custom: RepeatRule = { ...NO_REPEAT, freq: "custom", raw: rule };
  const parts = new Map<string, string>();
  for (const part of rule.toUpperCase().split(";")) {
    if (!part) continue;
    const [key, val] = part.split("=", 2);
    if (!key || val === undefined || parts.has(key)) return custom;
    parts.set(key, val);
  }
  const freq = FREQS[parts.get("FREQ") ?? ""];
  if (!freq) return custom;
  if ([...parts.keys()].some((k) => !SIMPLE_PARTS.has(k))) return custom;
  if (parts.has("COUNT") && parts.has("UNTIL")) return custom;

  const out: RepeatRule = { ...NO_REPEAT, freq };
  if (parts.has("INTERVAL")) {
    const n = Number(parts.get("INTERVAL"));
    if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL) return custom;
    out.interval = n;
  }
  if (parts.has("BYDAY")) {
    // Ordinal weekdays ("1MO", "-1FR") and BYDAY outside a weekly rule are custom.
    const days = (parts.get("BYDAY") ?? "").split(",");
    if (freq !== "weekly" || !days.every((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d))) return custom;
    out.days = WEEKDAYS.filter((d) => days.includes(d));
  }
  if (parts.has("COUNT")) {
    const n = Number(parts.get("COUNT"));
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) return custom;
    out.end = "count";
    out.count = n;
  } else if (parts.has("UNTIL")) {
    const date = untilDate(parts.get("UNTIL") ?? "");
    if (!date) return custom;
    out.end = "until";
    out.until = date;
  }
  return out;
}

/**
 * Build the RRULE string for a rule ("" when it does not repeat). Out-of-range numbers are written
 * as typed so `recurrenceError` can flag them instead of silently dropping the limit.
 */
export function buildRrule(rule: RepeatRule): string {
  if (rule.freq === "none") return "";
  if (rule.freq === "custom") return rule.raw;
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${Number.isFinite(rule.interval) ? Math.floor(rule.interval) : 0}`);
  if (rule.freq === "weekly" && rule.days.length > 0) parts.push(`BYDAY=${WEEKDAYS.filter((d) => rule.days.includes(d)).join(",")}`);
  if (rule.end === "count") parts.push(`COUNT=${Number.isFinite(rule.count) ? Math.floor(rule.count) : 0}`);
  if (rule.end === "until") parts.push(`UNTIL=${(rule.until && untilValue(rule.until)) || ""}`);
  return parts.join(";");
}

/** Client-side check of a rule string against the API limits; a message, or null when fine. */
export function recurrenceError(value: string | null | undefined): string | null {
  const rule = (value ?? "").trim().toUpperCase();
  if (!rule) return null;
  const part = (key: string) => new RegExp(`(?:^|;)${key}=([^;]*)`).exec(rule)?.[1];
  const interval = part("INTERVAL");
  if (interval !== undefined && !(/^\d+$/.test(interval) && Number(interval) >= 1 && Number(interval) <= MAX_INTERVAL)) return `Repeat every 1 to ${MAX_INTERVAL}.`;
  const count = part("COUNT");
  if (count !== undefined && !(/^\d+$/.test(count) && Number(count) >= 1 && Number(count) <= MAX_COUNT)) return `Enter 1 to ${MAX_COUNT} times.`;
  const until = part("UNTIL");
  if (until !== undefined && !untilDate(until)) return "Pick an end date.";
  if (count !== undefined && until !== undefined) return "Choose an end count or an end date, not both.";
  return null;
}

const UNIT: Record<Exclude<RepeatFreq, "none" | "custom">, [string, string]> = {
  daily: ["Daily", "days"],
  weekly: ["Weekly", "weeks"],
  monthly: ["Monthly", "months"],
  yearly: ["Yearly", "years"],
};

/** Short human summary, e.g. "Weekly on Mon, Wed · 4 times". "" when it does not repeat. */
export function describeRrule(value: string | null | undefined): string {
  const rule = parseRrule(value);
  if (rule.freq === "none") return "";
  if (rule.freq === "custom") return "Repeats (custom)";
  const [adverb, units] = UNIT[rule.freq];
  let text = rule.interval > 1 ? `Every ${rule.interval} ${units}` : adverb;
  if (rule.freq === "weekly" && rule.days.length > 0) {
    const days = rule.days.length === 5 && !rule.days.includes("SA") && !rule.days.includes("SU") ? "weekdays" : rule.days.map((d) => WEEKDAY_LABELS[d].long).join(", ");
    text += ` on ${days}`;
  }
  if (rule.end === "count") text += ` · ${rule.count} ${rule.count === 1 ? "time" : "times"}`;
  if (rule.end === "until" && rule.until) {
    const [y, m, d] = rule.until.split("-").map(Number);
    text += ` · until ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(y!, m! - 1, d!))}`;
  }
  return text;
}
