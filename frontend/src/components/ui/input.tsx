import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      className={cn(
        "flex h-9 w-full rounded-sm border border-border-strong bg-surface px-3 py-1 text-sm text-fg shadow-sm transition-colors",
        "placeholder:text-fg-subtle focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring/40 focus-visible:outline-offset-0",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-invalid:border-danger aria-invalid:focus-visible:outline-danger/40",
        className,
      )}
      {...props}
    />
  );
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || props["aria-invalid"] || undefined}
        className={cn(
          "flex min-h-20 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-fg shadow-sm",
          "placeholder:text-fg-subtle focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring/40 focus-visible:outline-offset-0",
          "disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger",
          className,
        )}
        {...props}
      />
    );
  },
);
