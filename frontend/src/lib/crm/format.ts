import type { Address, CustomFieldDefinition, CustomValue } from "@/lib/api/crm-types";

/** Format a decimal string with its ISO currency; falls back to a plain number when the code is unknown. */
export function formatMoney(amount: string | number | null | undefined, currency: string | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const value = typeof amount === "number" ? amount : Number(amount);
  if (Number.isNaN(value)) return String(amount);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toLocaleString()} ${currency ?? ""}`.trim();
  }
}

export function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  return Number.isNaN(n) ? String(value) : n.toLocaleString();
}

export function formatAddress(address: Address | null | undefined): string {
  if (!address) return "";
  return [address.line1, address.line2, address.city, address.state, address.postal_code, address.country].filter(Boolean).join(", ");
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

/** Human-readable custom-field value for tables and detail pages. */
export function formatCustomValue(definition: CustomFieldDefinition, value: CustomValue | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (definition.field_type) {
    case "checkbox":
      return value ? "Yes" : "No";
    case "multi_select":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "percent":
      return `${value}%`;
    case "datetime": {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }
    default:
      return Array.isArray(value) ? value.join(", ") : String(value);
  }
}

/** Initials-style short label for a stage/tag colour token → Tailwind classes (background + text). */
export function colorClasses(token: string | undefined): string {
  switch (token) {
    case "blue":
      return "bg-primary-soft text-primary";
    case "teal":
      return "bg-accent-soft text-accent";
    case "green":
      return "bg-success-soft text-success";
    case "amber":
      return "bg-warning-soft text-warning";
    case "red":
      return "bg-danger-soft text-danger";
    case "purple":
      return "bg-[#efe6fb] text-[#5b2ea6] dark:bg-[#2b1f45] dark:text-[#c9b3f5]";
    case "pink":
      return "bg-[#fbe4ee] text-[#a8305f] dark:bg-[#43202f] dark:text-[#f2b3cd]";
    default:
      return "bg-bg-subtle text-fg-muted";
  }
}

export function stageDotClass(token: string | undefined): string {
  switch (token) {
    case "blue":
      return "bg-primary";
    case "teal":
      return "bg-accent";
    case "green":
      return "bg-success";
    case "amber":
      return "bg-warning";
    case "red":
      return "bg-danger";
    case "purple":
      return "bg-[#7c4dff]";
    case "pink":
      return "bg-[#e0479e]";
    default:
      return "bg-fg-subtle";
  }
}
