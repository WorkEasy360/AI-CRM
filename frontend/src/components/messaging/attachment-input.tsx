"use client";

import * as React from "react";
import { Paperclip, X } from "lucide-react";
import { formatBytes } from "@/components/messaging/messaging-errors";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** File picker with a removable list. Limits mirror the backend (5 files, 10 MB each). */
export function AttachmentInput({
  files,
  onChange,
  error,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  const [localError, setLocalError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const id = React.useId();
  const message = error ?? localError;

  const add = (picked: FileList | null) => {
    if (!picked) return;
    const next = [...files];
    const problems: string[] = [];
    for (const file of Array.from(picked)) {
      if (next.length >= MAX_ATTACHMENTS) {
        problems.push(`You can attach at most ${MAX_ATTACHMENTS} files.`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problems.push(`${file.name} is ${formatBytes(file.size)}; the limit is 10 MB per file.`);
        continue;
      }
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
      next.push(file);
    }
    onChange(next);
    setLocalError(problems.length ? Array.from(new Set(problems)).join(" ") : null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id} className="sr-only">
          Attachments
        </Label>
        <input
          ref={inputRef}
          id={id}
          type="file"
          multiple
          className="sr-only"
          disabled={disabled || files.length >= MAX_ATTACHMENTS}
          aria-describedby={`${id}-help${message ? ` ${id}-error` : ""}`}
          onChange={(e) => add(e.target.files)}
        />
        <Button type="button" variant="secondary" size="sm" disabled={disabled || files.length >= MAX_ATTACHMENTS} onClick={() => inputRef.current?.click()}>
          <Paperclip /> Attach files
        </Button>
        <span id={`${id}-help`} className="text-xs text-fg-subtle">
          Up to {MAX_ATTACHMENTS} files, 10 MB each.
        </span>
      </div>
      {files.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Attached files">
          {files.map((file, index) => (
            <li key={`${file.name}-${file.size}`} className="flex items-center justify-between gap-2 rounded-sm border border-border bg-bg-subtle px-2 py-1 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <Paperclip className="size-3 shrink-0 text-fg-subtle" aria-hidden />
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 text-fg-subtle">({formatBytes(file.size)})</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() => onChange(files.filter((_, i) => i !== index))}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}
