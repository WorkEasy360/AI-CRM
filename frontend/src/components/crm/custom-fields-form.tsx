"use client";

import * as React from "react";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { CustomData, CustomFieldDefinition, CustomValue } from "@/lib/api/crm-types";
// Re-exported so the many `useCustomFields` call sites keep one import path.
export { useCustomFields } from "@/lib/crm/use-custom-fields";

function toLocalDateTime(value: CustomValue | undefined): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Renders inputs for every active custom field of an entity. Values are kept as the API expects
 * (strings for decimals/dates, booleans for checkboxes, arrays for multi-select, null to clear).
 */
export function CustomFieldsForm({
  definitions,
  value,
  onChange,
  errors,
  disabled,
}: {
  definitions: CustomFieldDefinition[];
  value: CustomData;
  onChange: (next: CustomData) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  const reactId = React.useId();
  if (definitions.length === 0) return null;

  const set = (key: string, v: CustomValue) => onChange({ ...value, [key]: v });

  return (
    <fieldset className="grid gap-4 sm:grid-cols-2" disabled={disabled}>
      <legend className="col-span-full text-xs font-semibold uppercase tracking-wide text-fg-subtle">Custom fields</legend>
      {definitions.map((d) => {
        const id = `${reactId}-${d.key}`;
        const err = errors?.[`custom_data.${d.key}`] ?? errors?.[d.key];
        const current = value[d.key];
        const label = (
          <Label htmlFor={id}>
            {d.label}
            {d.is_required ? <span className="ml-0.5 text-danger">*</span> : null}
          </Label>
        );
        const errorEl = err ? (
          <p role="alert" className="text-xs text-danger">
            {err}
          </p>
        ) : null;
        const wide = d.field_type === "textarea" || d.field_type === "multi_select";

        let control: React.ReactNode;
        switch (d.field_type) {
          case "textarea":
            control = <Textarea id={id} value={typeof current === "string" ? current : ""} onChange={(e) => set(d.key, e.target.value)} maxLength={5000} aria-invalid={Boolean(err) || undefined} />;
            break;
          case "integer":
          case "number":
          case "currency":
          case "percent":
            control = (
              <Input
                id={id}
                type="number"
                inputMode="decimal"
                step={d.field_type === "integer" ? 1 : "any"}
                min={d.field_type === "percent" ? 0 : undefined}
                max={d.field_type === "percent" ? 100 : undefined}
                value={current === null || current === undefined ? "" : String(current)}
                onChange={(e) => set(d.key, e.target.value === "" ? null : e.target.value)}
                aria-invalid={Boolean(err) || undefined}
              />
            );
            break;
          case "date":
            control = <Input id={id} type="date" value={typeof current === "string" ? current : ""} onChange={(e) => set(d.key, e.target.value || null)} aria-invalid={Boolean(err) || undefined} />;
            break;
          case "datetime":
            control = (
              <Input
                id={id}
                type="datetime-local"
                value={toLocalDateTime(current)}
                onChange={(e) => set(d.key, e.target.value ? new Date(e.target.value).toISOString() : null)}
                aria-invalid={Boolean(err) || undefined}
              />
            );
            break;
          case "checkbox":
            control = (
              <div className="flex h-9 items-center">
                <Switch id={id} checked={current === true} onCheckedChange={(checked) => set(d.key, checked)} aria-invalid={Boolean(err) || undefined} />
              </div>
            );
            break;
          case "dropdown":
            control = (
              <Select value={typeof current === "string" ? current : ""} onValueChange={(v) => set(d.key, v === "__none__" ? null : v)}>
                <SelectTrigger id={id} aria-invalid={Boolean(err) || undefined}>
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {!d.is_required ? <SelectItem value="__none__">— None —</SelectItem> : null}
                  {d.options.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
            break;
          case "multi_select": {
            const selectedValues = Array.isArray(current) ? current : [];
            control = (
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${id}-label`}>
                {d.options.map((o) => {
                  const checked = selectedValues.includes(o);
                  return (
                    <label key={o} className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-border-strong bg-surface px-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-[var(--kl-primary)]"
                        checked={checked}
                        onChange={() => set(d.key, checked ? selectedValues.filter((v) => v !== o) : [...selectedValues, o])}
                      />
                      {o}
                    </label>
                  );
                })}
              </div>
            );
            break;
          }
          case "email":
            control = <Input id={id} type="email" value={typeof current === "string" ? current : ""} onChange={(e) => set(d.key, e.target.value)} maxLength={254} aria-invalid={Boolean(err) || undefined} />;
            break;
          case "url":
            control = <Input id={id} type="url" value={typeof current === "string" ? current : ""} onChange={(e) => set(d.key, e.target.value)} maxLength={2048} aria-invalid={Boolean(err) || undefined} placeholder="https://" />;
            break;
          case "phone":
            control = <Input id={id} type="tel" value={typeof current === "string" ? current : ""} onChange={(e) => set(d.key, e.target.value)} maxLength={32} aria-invalid={Boolean(err) || undefined} />;
            break;
          default:
            control = <Input id={id} value={typeof current === "string" ? current : ""} onChange={(e) => set(d.key, e.target.value)} maxLength={255} aria-invalid={Boolean(err) || undefined} />;
        }

        return (
          <div key={d.id} className={wide ? "col-span-full flex flex-col gap-1.5" : "flex flex-col gap-1.5"}>
            {d.field_type === "multi_select" ? <span id={`${id}-label`}>{label}</span> : label}
            {control}
            {d.description ? <p className="text-xs text-fg-subtle">{d.description}</p> : null}
            {errorEl}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Read-only rendering of custom values for detail pages. */
export function CustomFieldsSummary({ definitions, value }: { definitions: CustomFieldDefinition[]; value: CustomData }) {
  if (definitions.length === 0) return null;
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {definitions.map((d) => {
        const v = value[d.key];
        let text: string;
        if (v === null || v === undefined || v === "") text = "—";
        else if (d.field_type === "checkbox") text = v ? "Yes" : "No";
        else if (Array.isArray(v)) text = v.join(", ");
        else if (d.field_type === "percent") text = `${v}%`;
        else text = String(v);
        return (
          <div key={d.id} className="min-w-0">
            <dt className="text-xs text-fg-subtle">{d.label}</dt>
            <dd className="truncate text-sm">{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}
