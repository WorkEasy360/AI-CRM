"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Address } from "@/lib/api/crm-types";

const FIELDS: { key: keyof Address; label: string; autoComplete: string; wide?: boolean }[] = [
  { key: "line1", label: "Address line 1", autoComplete: "address-line1", wide: true },
  { key: "line2", label: "Address line 2", autoComplete: "address-line2", wide: true },
  { key: "city", label: "City", autoComplete: "address-level2" },
  { key: "state", label: "State / region", autoComplete: "address-level1" },
  { key: "postal_code", label: "Postal code", autoComplete: "postal-code" },
  { key: "country", label: "Country", autoComplete: "country-name" },
];

/**
 * Postal address sub-form shared by the contact and company dialogs. Values are held by the parent
 * (like custom fields) so the react-hook-form schema stays flat.
 */
export function AddressFields({
  value,
  onChange,
  errors,
  disabled,
}: {
  value: Address;
  onChange: (next: Address) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  const reactId = React.useId();
  const general = errors?.address;
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2" disabled={disabled}>
      <legend className="col-span-full text-xs font-semibold uppercase tracking-wide text-fg-subtle">Address</legend>
      {general ? (
        <p role="alert" className="col-span-full text-xs text-danger">
          {general}
        </p>
      ) : null}
      {FIELDS.map((f) => {
        const id = `${reactId}-${f.key}`;
        const err = errors?.[`address.${f.key}`];
        return (
          <div key={f.key} className={f.wide ? "col-span-full flex flex-col gap-1.5" : "flex flex-col gap-1.5"}>
            <Label htmlFor={id}>{f.label}</Label>
            <Input
              id={id}
              value={value[f.key] ?? ""}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
              autoComplete={f.autoComplete}
              maxLength={200}
              aria-invalid={Boolean(err) || undefined}
              aria-describedby={err ? `${id}-error` : undefined}
            />
            {err ? (
              <p id={`${id}-error`} role="alert" className="text-xs text-danger">
                {err}
              </p>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Trim every line and drop the empty ones so the API only receives filled keys. */
export function cleanAddress(value: Address): Address {
  const out: Address = {};
  for (const [key, raw] of Object.entries(value)) {
    const trimmed = (raw ?? "").trim();
    if (trimmed) out[key as keyof Address] = trimmed;
  }
  return out;
}
