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
  "aria-required": true | undefined;
}

export interface FormFieldProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> {
  control: Control<TFieldValues>;
  name: TName;
  label?: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  /**
   * "horizontal" puts the label in a left column beside the control, which is how the
   * record slide-overs read; the default stacks it above for narrow dialogs and forms.
   * Both collapse to stacked below the `sm` breakpoint.
   */
  orientation?: "vertical" | "horizontal";
  /** Adds the asterisk and `aria-required`; validation itself stays with the schema. */
  required?: boolean;
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
  orientation = "vertical",
  required,
  serverError,
  children,
}: FormFieldProps<TFieldValues, TName>) {
  const reactId = React.useId();
  const id = `${name}-${reactId}`;
  const errorId = `${id}-error`;
  const descId = `${id}-desc`;
  const horizontal = orientation === "horizontal";
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const message = serverError ?? fieldState.error?.message;
        const invalid = Boolean(message);
        const describedBy = [description ? descId : null, message ? errorId : null].filter(Boolean).join(" ") || undefined;
        // The asterisk sits outside <label> so it never lands in the control's accessible name;
        // `aria-required` on the control is what actually announces the requirement.
        const labelNode = label ? (
          <div className={cn("flex items-baseline gap-0.5", horizontal && "sm:justify-end sm:pt-2")}>
            <Label htmlFor={id}>{label}</Label>
            {required ? (
              <span className="text-danger" aria-hidden>
                *
              </span>
            ) : null}
          </div>
        ) : null;
        const control = (
          <div className="flex min-w-0 flex-col gap-1.5">
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
              "aria-required": required || undefined,
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
        return (
          <div
            className={cn(
              horizontal ? "grid gap-1.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-start sm:gap-x-4" : "flex flex-col gap-1.5",
              className,
            )}
          >
            {labelNode}
            {control}
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
