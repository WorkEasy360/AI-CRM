"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Copy, Mail, Sparkles } from "lucide-react";
import { aiErrorMessage } from "@/components/crm/deals/deal-helpers";
import { EmailComposerDialog } from "@/components/messaging/email-composer-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { generateFollowUp } from "@/lib/api/crm";
import { AI_STYLES, type AIStyle, type Deal } from "@/lib/api/crm-types";
import { cn } from "@/lib/utils";

const STYLE_LABELS: Record<AIStyle, string> = { short: "Short", professional: "Professional", friendly: "Friendly", persuasive: "Persuasive" };
type Channel = "email" | "whatsapp";

export interface FollowUpContact {
  id: string;
  name: string;
  email: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * AI-drafted follow-up for a deal. The member picks a tone and channel, reviews and edits the draft,
 * then copies it or opens the email composer. Nothing is ever sent from here.
 */
export function FollowUpDialog({ open, onOpenChange, deal, contact }: { open: boolean; onOpenChange: (open: boolean) => void; deal: Deal; contact: FollowUpContact | null }) {
  const { toast } = useToast();
  const [tone, setTone] = React.useState<AIStyle>("professional");
  const [channel, setChannel] = React.useState<Channel>("email");
  const [draft, setDraft] = React.useState("");
  const [flagged, setFlagged] = React.useState(false);
  const [composerOpen, setComposerOpen] = React.useState(false);
  const toneId = React.useId();
  const draftId = React.useId();

  const generate = useMutation({
    mutationFn: () => generateFollowUp({ entity_type: "deal", entity_id: deal.id, tone, channel }),
    onSuccess: (result) => {
      setDraft(result.draft);
      setFlagged(result.flagged_input);
    },
  });

  React.useEffect(() => {
    if (open) {
      setDraft("");
      setFlagged(false);
      generate.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const copy = async () => {
    const ok = await copyText(draft);
    toast(ok ? { tone: "success", title: "Draft copied" } : { tone: "error", title: "Could not copy", description: "Select the text and copy it by hand." });
    return ok;
  };

  const useInEmail = async () => {
    await copy();
    toast({ tone: "info", title: "Paste the draft into the email body", description: "The composer opens with the contact and deal filled in." });
    onOpenChange(false);
    setComposerOpen(true);
  };

  const canEmail = channel === "email" && Boolean(contact?.email);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-lg overflow-y-auto">
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Generate follow-up</DialogTitle>
              <DialogDescription>AI drafts a message from this deal&apos;s history. You review, edit and send it yourself — nothing goes out automatically.</DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={toneId}>Tone</Label>
                <Select value={tone} onValueChange={(v) => setTone(v as AIStyle)}>
                  <SelectTrigger id={toneId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AI_STYLES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STYLE_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium leading-none">Channel</span>
                <div className="inline-flex h-9 items-center gap-0.5 rounded-sm bg-bg-subtle p-0.5" role="group" aria-label="Channel">
                  {(["email", "whatsapp"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={channel === c}
                      onClick={() => setChannel(c)}
                      className={cn("h-8 flex-1 rounded-sm px-3 text-xs font-medium transition-colors", channel === c ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
                    >
                      {c === "email" ? "Email" : "WhatsApp"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <Button size="sm" variant={draft ? "secondary" : "primary"} onClick={() => generate.mutate()} loading={generate.isPending}>
                <Sparkles /> {draft ? "Generate again" : "Generate draft"}
              </Button>
            </div>

            {generate.isError ? (
              <p role="alert" className="text-sm text-danger">
                {aiErrorMessage(generate.error)}
              </p>
            ) : null}

            {draft || generate.isSuccess ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={draftId}>Draft (editable)</Label>
                <Textarea id={draftId} value={draft} onChange={(e) => setDraft(e.target.value)} rows={channel === "email" ? 9 : 5} maxLength={5000} />
                {flagged ? (
                  <p className="flex items-start gap-2 rounded-sm border border-warning/40 bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                    Some source text was flagged and left out. Read the draft carefully before using it.
                  </p>
                ) : null}
                <p className="text-[11px] text-fg-subtle">AI-generated draft — check names, numbers and promises before sending.</p>
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="button" variant="secondary" onClick={copy} disabled={!draft}>
                <Copy /> Copy
              </Button>
              {channel === "email" ? (
                <Button type="button" onClick={useInEmail} disabled={!draft || !canEmail} title={canEmail ? undefined : "The primary contact has no email address."}>
                  <Mail /> Use in email
                </Button>
              ) : null}
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
      <EmailComposerDialog open={composerOpen} onOpenChange={setComposerOpen} contact={contact} deal={{ id: deal.id, name: deal.name }} company={deal.company} />
    </>
  );
}
