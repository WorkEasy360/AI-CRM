"use client";

import * as React from "react";
import { Controller, type Control, type FieldPath, type FieldValues } from "react-hook-form";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * FormField: a labelled field wired to react-hook-form via Controller.
 * The render callback receives the field props plus computed a11y ids so any
 * control (Input, Select, Switch) can be dropped in.
 */
export interface FormFieldRenderProps<TValue> {
  id: string;
  name: string;
  value: TValue;
  onChange: (value: TValue) => void;
  onBlur: () => void;
  /** Callback ref (contravariant, so it fits any element type's ref prop). */
  ref: (instance: HTMLElement | null) => void;
  invalid: boolean;
  disabled?: boolean;
  "aria-invalid": boolean | undefined;
  "aria-describedby": string | undefined;
}

export interface FormFieldProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> {
  control: Control<TFieldValues>;
  name: TName;
  label?: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  /** Server-side error for this field (takes precedence over client validation when present). */
  serverError?: string;
  children: (field: FormFieldRenderProps<TFieldValues[TName]>) => React.ReactNode;
}

export function FormField<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  className,
  serverError,
  children,
}: FormFieldProps<TFieldValues, TName>) {
  const reactId = React.useId();
  const id = `${name}-${reactId}`;
  const errorId = `${id}-error`;
  const descId = `${id}-desc`;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const message = serverError ?? fieldState.error?.message;
        const invalid = Boolean(message);
        const describedBy = [description ? descId : null, message ? errorId : null].filter(Boolean).join(" ") || undefined;
        return (
          <div className={cn("flex flex-col gap-1.5", className)}>
            {label ? <Label htmlFor={id}>{label}</Label> : null}
            {children({
              id,
              name: field.name,
              value: field.value,
              onChange: field.onChange,
              onBlur: field.onBlur,
              ref: field.ref,
              invalid,
              disabled: field.disabled,
              "aria-invalid": invalid || undefined,
              "aria-describedby": describedBy,
            })}
            {description ? (
              <p id={descId} className="text-xs text-fg-subtle">
                {description}
              </p>
            ) : null}
            {message ? (
              <p id={errorId} role="alert" className="text-xs text-danger">
                {message}
              </p>
            ) : null}
          </div>
        );
      }}
    />
  );
}

/** Non-field error banner for forms. */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-sm border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </div>
  );
}
