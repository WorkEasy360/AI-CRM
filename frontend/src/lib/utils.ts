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

export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = typeof value === "number" ? new Date(value * (value < 1e12 ? 1000 : 1)) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export function humanize(value: string): string {
  return value.replace(/[_.-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
