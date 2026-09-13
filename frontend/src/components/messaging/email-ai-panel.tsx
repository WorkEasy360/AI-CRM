"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { aiErrorMessage } from "@/components/messaging/messaging-errors";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { draftEmailWithAI } from "@/lib/api/crm";
import { AI_EMAIL_PURPOSES, AI_TONES, type AIEmailOperation, type AIEmailPurpose, type AITone, type EmailDraft } from "@/lib/api/crm-types";

export const AI_TONE_LABELS: Record<AITone, string> = {
  professional: "Professional",
  friendly: "Friendly",
  concise: "Concise",
  persuasive: "Persuasive",
};

const OPERATIONS: { op: AIEmailOperation; label: string; needsBody: boolean }[] = [
  { op: "generate", label: "Generate", needsBody: false },
  { op: "shorten", label: "Shorten", needsBody: true },
  { op: "rewrite", label: "Rewrite", needsBody: true },
  { op: "professional", label: "More professional", needsBody: true },
  { op: "friendly", label: "Friendlier", needsBody: true },
];

function isPurpose(value: string): value is AIEmailPurpose {
  return AI_EMAIL_PURPOSES.some((p) => p.value === value);
}
function isTone(value: string): value is AITone {
  return (AI_TONES as readonly string[]).includes(value);
}

/**
 * "Write with AI" section of the email composer. Every result is a draft handed back to the
 * composer for review; nothing here sends anything.
 */
export function EmailAIPanel({
  contactId,
  dealId,
  body,
  disabled,
  onDraft,
}: {
  contactId?: string | null;
  dealId?: string | null;
  /** Current body, used by the rewrite-style operations. */
  body: string;
  disabled?: boolean;
  onDraft: (draft: EmailDraft) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [purpose, setPurpose] = React.useState<AIEmailPurpose>("follow_up_meeting");
  const [tone, setTone] = React.useState<AITone>("professional");
  const [instructions, setInstructions] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const baseId = React.useId();

  const draft = useMutation({
    mutationFn: (operation: AIEmailOperation) =>
      draftEmailWithAI({
        contact_id: contactId ?? null,
        deal_id: dealId ?? null,
        purpose,
        tone,
        operation,
        text: operation === "generate" ? undefined : body,
        instructions: instructions.trim() || undefined,
      }),
    onSuccess: (result) => {
      setError(null);
      onDraft(result);
    },
    onError: (err) => setError(aiErrorMessage(err)),
  });

  const hasBody = body.trim().length > 0;

  return (
    <section aria-labelledby={`${baseId}-title`} className="rounded-md border border-border bg-bg-subtle/50">
      <button
        type="button"
        id={`${baseId}-title`}
        aria-expanded={open}
        aria-controls={`${baseId}-panel`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between gap-2 px-3 text-sm font-medium text-fg hover:bg-bg-subtle"
      >
        <span className="inline-flex items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden /> Write with AI
        </span>
        {open ? <ChevronUp className="size-4 text-fg-subtle" aria-hidden /> : <ChevronDown className="size-4 text-fg-subtle" aria-hidden />}
      </button>
      {open ? (
        <div id={`${baseId}-panel`} className="grid gap-3 border-t border-border px-3 py-3">
          <p className="text-xs text-fg-muted">
            Drafts use the CRM context for this contact and deal. Review every draft before sending; nothing is sent automatically.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${baseId}-purpose`}>Purpose</Label>
              <Select value={purpose} onValueChange={(v) => isPurpose(v) && setPurpose(v)} disabled={disabled || draft.isPending}>
                <SelectTrigger id={`${baseId}-purpose`} className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_EMAIL_PURPOSES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${baseId}-tone`}>Tone</Label>
              <Select value={tone} onValueChange={(v) => isTone(v) && setTone(v)} disabled={disabled || draft.isPending}>
                <SelectTrigger id={`${baseId}-tone`} className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_TONES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {AI_TONE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${baseId}-instructions`}>Instructions (optional)</Label>
            <Input
              id={`${baseId}-instructions`}
              className="h-8"
              maxLength={500}
              placeholder="e.g. mention the pricing discussed on Tuesday"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={disabled || draft.isPending}
            />
          </div>
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            {OPERATIONS.map(({ op, label, needsBody }) => (
              <Button
                key={op}
                type="button"
                size="sm"
                variant={op === "generate" ? "primary" : "secondary"}
                disabled={disabled || (needsBody && !hasBody) || (draft.isPending && draft.variables !== op)}
                loading={draft.isPending && draft.variables === op}
                title={needsBody && !hasBody ? "Write or generate a body first." : undefined}
                onClick={() => draft.mutate(op)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
