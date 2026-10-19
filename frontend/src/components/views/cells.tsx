"use client";

import * as React from "react";
import type { CellValue, FieldDescriptor, MembershipRef, NamedRef, TagRef } from "@/lib/api/crm-types";
import { formatMoney, formatNumber } from "@/lib/crm/format";
import { formatDate, formatDateTime, humanize } from "@/lib/utils";

/** Field types the grid can edit in place (lookups and owners are edited on the record page). */
export const INLINE_EDIT_TYPES = new Set([
  "text",
  "textarea",
  "email",
  "phone",
  "url",
  "integer",
  "number",
  "money",
  "percent",
  "date",
  "datetime",
  "boolean",
  "choice",
  "stage",
]);

export function canEditInline(field: FieldDescriptor): boolean {
  return field.editable && !field.read_only && INLINE_EDIT_TYPES.has(field.type);
}

function isRef(value: CellValue): value is NamedRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "name" in value;
}

function isMember(value: CellValue): value is MembershipRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "display_name" in value;
}

/** Plain text of a cell, used for display, copy and the calendar/kanban cards. */
export function cellText(field: FieldDescriptor, value: CellValue | undefined, currency?: string): string {
  if (value === null || value === undefined || value === "") return "";
  switch (field.type) {
    case "money":
      return formatMoney(value as string, currency);
    case "number":
    case "integer":
      return formatNumber(value as string);
    case "percent":
      return `${value}%`;
    case "date":
      return formatDate(value as string);
    case "datetime":
      return formatDateTime(value as string);
    case "boolean":
      return value ? "Yes" : "No";
    case "choice":
      return humanize(String(value));
    case "multi_choice":
      return Array.isArray(value) ? (value as string[]).join(", ") : String(value);
    case "tags":
      return Array.isArray(value) ? (value as TagRef[]).map((t) => t.name).join(", ") : "";
    case "user":
      return isMember(value) ? value.display_name : "";
    case "lookup":
    case "stage":
      return isRef(value) ? value.name : String(value);
    default:
      return String(value);
  }
}

/** The raw value a cell edit sends (what the API's write serializer expects for that type). */
export function rawOf(field: FieldDescriptor, value: CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (field.type === "stage" || field.type === "lookup") return isRef(value) ? value.id : String(value);
  if (field.type === "boolean") return value ? "true" : "false";
  return String(value);
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse typed or pasted text into the value sent to the API; local checks only (the server re-validates). */
export function parseCell(field: FieldDescriptor, text: string, stageIdByName?: Map<string, string>): Parsed {
  const raw = text.trim();
  if (raw === "") {
    if (field.required) return { ok: false, error: `${field.label} is required.` };
    if (field.type === "boolean") return { ok: true, value: false };
    return { ok: true, value: ["text", "textarea", "email", "phone", "url", "choice"].includes(field.type) ? "" : null };
  }
  switch (field.type) {
    case "integer":
    case "number":
    case "money":
    case "percent": {
      const n = raw.replace(/[,\s%]/g, "").replace(/^[^\d.-]+/, "");
      if (!/^-?\d+(\.\d+)?$/.test(n)) return { ok: false, error: "Enter a number." };
      if (field.type === "integer" && n.includes(".")) return { ok: false, error: "Enter a whole number." };
      return { ok: true, value: field.type === "integer" || field.key === "probability" ? Number.parseInt(n, 10) : n };
    }
    case "boolean": {
      const v = raw.toLowerCase();
      if (["true", "yes", "y", "1"].includes(v)) return { ok: true, value: true };
      if (["false", "no", "n", "0"].includes(v)) return { ok: true, value: false };
      return { ok: false, error: "Enter yes or no." };
    }
    case "date": {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : toIsoDate(raw);
      return iso ? { ok: true, value: iso } : { ok: false, error: "Enter a date as YYYY-MM-DD." };
    }
    case "datetime": {
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? { ok: false, error: "Enter a date and time." } : { ok: true, value: d.toISOString() };
    }
    case "choice": {
      const match = field.choices.find((c) => c.toLowerCase() === raw.toLowerCase() || humanize(c).toLowerCase() === raw.toLowerCase());
      return match ? { ok: true, value: match } : { ok: false, error: `Choose one of: ${field.choices.map(humanize).join(", ")}.` };
    }
    case "stage": {
      const id = stageIdByName?.get(raw.toLowerCase()) ?? (/^[0-9a-f-]{36}$/i.test(raw) ? raw : undefined);
      return id ? { ok: true, value: id } : { ok: false, error: "Unknown stage." };
    }
    default:
      return { ok: true, value: raw };
  }
}

function toIsoDate(text: string): string | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** The in-place editor for one cell. Enter/blur commits, Escape cancels. */
export function CellEditor({
  field,
  initial,
  stageOptions,
  onCommit,
  onCancel,
}: {
  field: FieldDescriptor;
  initial: string;
  stageOptions?: { id: string; name: string }[];
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = React.useState(initial);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && field.type !== "textarea") {
      e.preventDefault();
      e.stopPropagation();
      onCommit(text);
    }
  };
  const common = "h-full w-full border-0 bg-surface px-2 text-sm text-fg outline-none ring-2 ring-primary";
  if (field.type === "choice" || field.type === "stage" || field.type === "boolean") {
    const options =
      field.type === "boolean"
        ? [
            { id: "true", name: "Yes" },
            { id: "false", name: "No" },
          ]
        : field.type === "stage"
          ? (stageOptions ?? [])
          : field.choices.map((c) => ({ id: c, name: humanize(c) }));
    return (
      <select
        autoFocus
        aria-label={field.label}
        className={common}
        value={text}
        onChange={(e) => onCommit(e.target.value)}
        onBlur={() => onCancel()}
        onKeyDown={keys}
      >
        {field.required ? null : <option value="">—</option>}
        {options.map((o) => (
          <option key={o.id} value={field.type === "stage" ? o.name : o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  const type =
    field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : ["integer", "number", "money", "percent"].includes(field.type) ? "text" : "text";
  return (
    <input
      autoFocus
      aria-label={field.label}
      className={common}
      type={type}
      inputMode={["integer", "number", "money", "percent"].includes(field.type) ? "decimal" : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={keys}
    />
  );
}
