"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Sparkles } from "lucide-react";
import { AttachmentInput } from "@/components/messaging/attachment-input";
import { EmailAIPanel } from "@/components/messaging/email-ai-panel";
import { EMAIL_SETTINGS_HREF, isProblem } from "@/components/messaging/messaging-errors";
import { RecipientInput, isValidEmail } from "@/components/messaging/recipient-input";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { listEmailTemplates, renderEmailTemplate, sendEmail } from "@/lib/api/crm";
import type { EmailDraft, EmailMessage, EmailSendInput, NamedRef, RelatedEntityType } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

export interface ComposerContact {
  id: string;
  name: string;
  email: string;
}

const NONE = "__none__";
const MAX_BODY = 50_000;
const MAX_SUBJECT = 255;
/** Provider status usually settles a few seconds after queueing; refetch once so the list updates. */
const STATUS_REFRESH_MS = 6000;

interface Draft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

function quote(message: EmailMessage): string {
  const when = formatDateTime(message.received_at ?? message.sent_at ?? message.created_at);
  const quoted = message.body_text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\nOn ${when}, ${message.from_address} wrote:\n${quoted}`;
}

function initialDraft(contact: ComposerContact | null, replyTo: EmailMessage | null): Draft {
  if (replyTo) {
    const to = replyTo.direction === "inbound" ? [replyTo.from_address] : replyTo.to_addresses;
    return {
      to: to.filter(isValidEmail),
      cc: [],
      bcc: [],
      subject: /^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`.trim(),
      body: quote(replyTo),
    };
  }
  return { to: contact && isValidEmail(contact.email) ? [contact.email] : [], cc: [], bcc: [], subject: "", body: "" };
}

/**
 * Compose and queue an email from the member's connected mailbox. Templates and AI only fill the
 * draft; the person reviews and presses Send.
 */
export function EmailComposerDialog({
  open,
  onOpenChange,
  contact = null,
  deal = null,
  company = null,
  replyTo = null,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: ComposerContact | null;
  deal?: NamedRef | null;
  company?: NamedRef | null;
  replyTo?: EmailMessage | null;
  onSent?: (message: EmailMessage) => void;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canSend = can(active, "email.send");
  const canAI = can(active, "ai.copilot.use");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const baseId = React.useId();

  const [draft, setDraft] = React.useState<Draft>(() => initialDraft(contact, replyTo));
  const [showCc, setShowCc] = React.useState(false);
  const [attachments, setAttachments] = React.useState<File[]>([]);
  const [templateId, setTemplateId] = React.useState<string>(NONE);
  const [pendingTemplate, setPendingTemplate] = React.useState<string | null>(null);
  const [aiAssisted, setAiAssisted] = React.useState(false);
  const [flagged, setFlagged] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [notConnected, setNotConnected] = React.useState(false);
  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const contactId = contact?.id ?? replyTo?.contact?.id ?? null;
  const dealId = deal?.id ?? replyTo?.deal?.id ?? null;
  const companyId = company?.id ?? replyTo?.company?.id ?? null;

  React.useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(contact, replyTo));
    setShowCc(false);
    setAttachments([]);
    setTemplateId(NONE);
    setPendingTemplate(null);
    setAiAssisted(false);
    setFlagged(false);
    setFieldErrors({});
    setNotConnected(false);
    // Reset when the dialog opens or is pointed at another record/message, not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact?.id, contact?.email, replyTo?.id]);

  React.useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  const templates = useQuery({ queryKey: crmKeys.emailTemplates, queryFn: listEmailTemplates, enabled: open && canSend, staleTime: 60_000 });

  const patch = (partial: Partial<Draft>) => setDraft((d) => ({ ...d, ...partial }));

  const applyTemplate = useMutation({
    mutationFn: (id: string) => renderEmailTemplate(id, { contact: contactId ?? undefined, deal: dealId ?? undefined }),
    onSuccess: (rendered, id) => {
      patch({ subject: rendered.subject, body: rendered.body });
      setTemplateId(id);
      setAiAssisted(false);
      setFlagged(false);
      setPendingTemplate(null);
    },
    onError: (err) => {
      setPendingTemplate(null);
      toast({ tone: "error", title: "Could not apply template", description: errorMessage(err) });
    },
  });

  const chooseTemplate = (id: string) => {
    if (id === NONE) {
      setTemplateId(NONE);
      return;
    }
    if (draft.body.trim()) setPendingTemplate(id);
    else applyTemplate.mutate(id);
  };

  const insertAIDraft = (result: EmailDraft) => {
    patch({ body: result.body, subject: result.subject || draft.subject });
    setAiAssisted(true);
    setFlagged(result.flagged_input);
    setTemplateId(NONE);
  };

  const linked = React.useMemo(() => {
    const out: { entity: RelatedEntityType; id: string }[] = [];
    if (contactId) out.push({ entity: "contact", id: contactId });
    if (companyId) out.push({ entity: "company", id: companyId });
    if (dealId) out.push({ entity: "deal", id: dealId });
    return out;
  }, [contactId, companyId, dealId]);

  const invalidateHistory = React.useCallback(
    () =>
      Promise.all(
        linked.flatMap(({ entity, id }) => [
          queryClient.invalidateQueries({ queryKey: crmKeys.recordEmails(entity, id) }),
          queryClient.invalidateQueries({ queryKey: crmKeys.timeline(entity, id) }),
        ]),
      ),
    [linked, queryClient],
  );

  const send = useMutation({
    mutationFn: () => {
      const input: EmailSendInput = {
        to: draft.to,
        ...(draft.cc.length ? { cc: draft.cc } : {}),
        ...(draft.bcc.length ? { bcc: draft.bcc } : {}),
        subject: draft.subject.trim(),
        body: draft.body,
        contact_id: contactId,
        company_id: companyId,
        deal_id: dealId,
        template_id: templateId === NONE ? null : templateId,
        in_reply_to_id: replyTo?.id ?? null,
        ai_assisted: aiAssisted,
      };
      return sendEmail(input, attachments);
    },
    onSuccess: async (message) => {
      await invalidateHistory();
      refreshTimer.current = setTimeout(() => void invalidateHistory(), STATUS_REFRESH_MS);
      toast({
        tone: "success",
        title: message.status === "sent" ? "Email sent" : "Email queued",
        description: message.status === "sent" ? undefined : "It will go out from your mailbox in a moment.",
      });
      onSent?.(message);
      onOpenChange(false);
    },
    onError: (err) => {
      if (isProblem(err, "email_not_connected", 409)) {
        setNotConnected(true);
        return;
      }
      if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
        return;
      }
      toast({ tone: "error", title: "Could not send email", description: errorMessage(err) });
    },
  });

  if (!canSend) return null;

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (draft.to.length === 0) errors.to = "Add at least one recipient.";
    if (!draft.body.trim()) errors.body = "Write a message before sending.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (send.isPending) return;
    if (validate()) send.mutate();
  };

  const busy = send.isPending || applyTemplate.isPending;
  const title = replyTo ? "Reply" : "New email";
  const context = [contact?.name, deal?.name, company?.name].filter(Boolean).join(" · ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {context ? `Linked to ${context}. ` : ""}Sent from your connected mailbox and logged on the record.
            </DialogDescription>
          </DialogHeader>

          {notConnected ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
              <span>Your mailbox is not connected, so this email cannot be sent yet.</span>
              <Link href={EMAIL_SETTINGS_HREF} className="font-medium underline underline-offset-4">
                Connect a mailbox in Settings → Email
              </Link>
            </div>
          ) : null}
          <FormError message={fieldErrors.non_field_errors} />

          <div className="grid gap-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <RecipientInput id={`${baseId}-to`} label="To" value={draft.to} onChange={(to) => patch({ to })} placeholder="name@company.com" error={fieldErrors.to} disabled={busy} />
              </div>
              {!showCc ? (
                <Button type="button" variant="ghost" size="sm" className="mt-6 shrink-0" onClick={() => setShowCc(true)}>
                  Cc/Bcc
                </Button>
              ) : null}
            </div>
            {showCc ? (
              <>
                <RecipientInput id={`${baseId}-cc`} label="Cc" value={draft.cc} onChange={(cc) => patch({ cc })} error={fieldErrors.cc} disabled={busy} />
                <RecipientInput id={`${baseId}-bcc`} label="Bcc" value={draft.bcc} onChange={(bcc) => patch({ bcc })} error={fieldErrors.bcc} disabled={busy} />
              </>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
              <div className="grid gap-1.5">
                <Label htmlFor={`${baseId}-subject`}>Subject</Label>
                <Input
                  id={`${baseId}-subject`}
                  maxLength={MAX_SUBJECT}
                  value={draft.subject}
                  onChange={(e) => patch({ subject: e.target.value })}
                  disabled={busy}
                  aria-invalid={fieldErrors.subject ? true : undefined}
                  aria-describedby={fieldErrors.subject ? `${baseId}-subject-error` : undefined}
                />
                {fieldErrors.subject ? (
                  <p id={`${baseId}-subject-error`} role="alert" className="text-xs text-danger">
                    {fieldErrors.subject}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${baseId}-template`}>Template</Label>
                <Select value={templateId} onValueChange={chooseTemplate} disabled={busy || templates.isPending}>
                  <SelectTrigger id={`${baseId}-template`}>
                    <SelectValue placeholder="No template" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No template</SelectItem>
                    {(templates.data?.results ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`${baseId}-body`}>Message</Label>
                {aiAssisted ? (
                  <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
                    <Sparkles className="size-3 text-primary" aria-hidden /> Draft by AI — review before sending
                  </span>
                ) : null}
              </div>
              <Textarea
                id={`${baseId}-body`}
                rows={10}
                maxLength={MAX_BODY}
                value={draft.body}
                onChange={(e) => patch({ body: e.target.value })}
                disabled={busy}
                placeholder="Write in plain text. Line breaks are kept."
                aria-invalid={fieldErrors.body ? true : undefined}
                aria-describedby={fieldErrors.body ? `${baseId}-body-error` : undefined}
              />
              {fieldErrors.body ? (
                <p id={`${baseId}-body-error`} role="alert" className="text-xs text-danger">
                  {fieldErrors.body}
                </p>
              ) : null}
              {flagged ? (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  Some CRM notes contained suspicious instructions and were ignored while drafting.
                </p>
              ) : null}
            </div>

            {canAI ? <EmailAIPanel contactId={contactId} dealId={dealId} body={draft.body} disabled={busy} onDraft={insertAIDraft} /> : null}

            <AttachmentInput files={attachments} onChange={setAttachments} error={fieldErrors.attachments} disabled={busy} />
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={send.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={send.isPending} disabled={notConnected || applyTemplate.isPending}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      <ConfirmDialog
        open={pendingTemplate !== null}
        onOpenChange={(o) => !o && setPendingTemplate(null)}
        title="Replace the current message?"
        description="Applying a template overwrites the subject and body you have written so far."
        confirmLabel="Apply template"
        loading={applyTemplate.isPending}
        onConfirm={() => pendingTemplate && applyTemplate.mutate(pendingTemplate)}
      />
    </Dialog>
  );
}
