"use client";

import * as React from "react";
import { X } from "lucide-react";
import { z } from "zod";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const EMAIL = z.email();
const SEPARATORS = /[,;\s]+/;

export function isValidEmail(value: string): boolean {
  return EMAIL.safeParse(value).success;
}

/** Split pasted or typed text into candidate addresses. */
export function splitAddresses(text: string): string[] {
  return text
    .split(SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Email addresses as removable chips. Typing an address and pressing Enter, comma, semicolon or
 * space (or leaving the field) adds it; invalid addresses stay in the box with an inline error.
 */
export function RecipientInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  error,
  disabled,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  error?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = React.useState("");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;
  const message = error ?? localError;

  const commit = (text: string) => {
    const candidates = splitAddresses(text);
    if (candidates.length === 0) {
      setDraft("");
      return;
    }
    const seen = new Set(value.map((v) => v.toLowerCase()));
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const candidate of candidates) {
      if (!isValidEmail(candidate)) rejected.push(candidate);
      else if (!seen.has(candidate.toLowerCase())) {
        seen.add(candidate.toLowerCase());
        accepted.push(candidate);
      }
    }
    if (accepted.length) onChange([...value, ...accepted]);
    setDraft(rejected.join(", "));
    setLocalError(rejected.length ? `Enter a valid email address: ${rejected.join(", ")}` : null);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-sm border border-border-strong bg-surface px-2 py-1 text-sm shadow-sm",
          "focus-within:border-ring focus-within:outline-2 focus-within:outline-ring/40 focus-within:outline-offset-0",
          message && "border-danger",
          disabled && "opacity-60",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((address, index) => (
          <span key={`${address}-${index}`} className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-bg-subtle pl-2 pr-1 text-xs">
            <span className="max-w-56 truncate">{address}</span>
            <button
              type="button"
              aria-label={`Remove ${address}`}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                remove(index);
              }}
              className="rounded-full p-0.5 text-fg-subtle hover:bg-border hover:text-fg"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="email"
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          value={draft}
          placeholder={value.length === 0 ? placeholder : undefined}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? errorId : undefined}
          className="h-6 min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
          onChange={(e) => {
            const text = e.target.value;
            if (/[,;\s]$/.test(text)) commit(text);
            else {
              setDraft(text);
              if (localError) setLocalError(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === ";") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
              e.preventDefault();
              remove(value.length - 1);
            }
          }}
          onBlur={() => commit(draft)}
        />
      </div>
      {message ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}
