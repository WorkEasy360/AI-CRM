import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names, resolving conflicts (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Two-letter initials from a display name or email. */
export function initials(name: string | undefined | null, fallback = "?"): string {
  if (!name) return fallback;
  const cleaned = name.includes("@") ? name.split("@")[0] ?? name : name;
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
  return (first + second).toUpperCase();
}

/** Date formats a workspace may choose in General settings (the backend accepts exactly these). */
export const DATE_FORMATS = ["DD MMM YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

let workspaceDateFormat: DateFormat | null = null;

/** Set by the app shell from the active organization; null keeps the viewer's locale format. */
export function setWorkspaceDateFormat(format: string | null | undefined): void {
  workspaceDateFormat = (DATE_FORMATS as readonly string[]).includes(format ?? "") ? (format as DateFormat) : null;
}

function datePart(date: Date, format: DateFormat): string {
  const parts = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: format === "DD MMM YYYY" ? "short" : "2-digit", year: "numeric" }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const [d, m, y] = [get("day"), get("month"), get("year")];
  switch (format) {
    case "DD MMM YYYY":
      return `${d} ${m} ${y}`;
    case "DD/MM/YYYY":
      return `${d}/${m}/${y}`;
    case "MM/DD/YYYY":
      return `${m}/${d}/${y}`;
    case "YYYY-MM-DD":
      return `${y}-${m}-${d}`;
  }
}

export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = typeof value === "number" ? new Date(value * (value < 1e12 ? 1000 : 1)) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  if (workspaceDateFormat) return `${datePart(date, workspaceDateFormat)}, ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date)}`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (workspaceDateFormat) return datePart(date, workspaceDateFormat);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function humanize(value: string): string {
  return value.replace(/[_.-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
