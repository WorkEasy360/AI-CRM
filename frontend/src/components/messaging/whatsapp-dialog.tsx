"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, Sparkles } from "lucide-react";
import { aiErrorMessage, isProblem, WHATSAPP_SETTINGS_HREF } from "@/components/messaging/messaging-errors";
import { approvedTemplates, WhatsAppTemplateFields } from "@/components/messaging/whatsapp-template-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { generateFollowUp, listWhatsAppTemplates, sendWhatsApp, whatsAppWindow } from "@/lib/api/crm";
import { AI_STYLES, type AIStyle, type NamedRef, type WhatsAppMessage, type WhatsAppSendInput } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

export interface WhatsAppContact {
  id: string;
  name: string;
  phone: string;
  whatsapp_opt_in: boolean;
}

export const MAX_WHATSAPP_TEXT = 4096;
export const CONSENT_HINT = "Record WhatsApp consent on the contact first.";

const STYLE_LABELS: Record<AIStyle, string> = { short: "Short", professional: "Professional", friendly: "Friendly", persuasive: "Persuasive" };
function isStyle(value: string): value is AIStyle {
  return (AI_STYLES as readonly string[]).includes(value);
}

/** Invalidate everything that shows WhatsApp state for a contact (and its deal). */
export function useInvalidateWhatsApp(contactId: string, dealId?: string | null) {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    const keys = [
      crmKeys.whatsappMessages("contact", contactId),
      crmKeys.whatsappWindow(contactId),
      crmKeys.timeline("contact", contactId),
      ...(dealId ? [crmKeys.whatsappMessages("deal", dealId), crmKeys.timeline("deal", dealId)] : []),
    ];
    return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }, [queryClient, contactId, dealId]);
}

/**
 * Send a WhatsApp message to a contact. Free text is allowed only inside the 24-hour service
 * window; otherwise an approved template is required and the contact must have opted in.
 */
export function WhatsAppDialog({
  open,
  onOpenChange,
  contact,
  deal = null,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: WhatsAppContact;
  deal?: NamedRef | null;
  onSent?: (message: WhatsAppMessage) => void;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canSend = can(active, "whatsapp.send");
  const canManage = can(active, "whatsapp.manage");
  const canAI = can(active, "ai.copilot.use");
  const { toast } = useToast();
  const invalidate = useInvalidateWhatsApp(contact.id, deal?.id);
  const baseId = React.useId();

  const [body, setBody] = React.useState("");
  const [templateId, setTemplateId] = React.useState("");
  const [params, setParams] = React.useState<string[]>([]);
  const [style, setStyle] = React.useState<AIStyle>("short");
  const [aiAssisted, setAiAssisted] = React.useState(false);
  const [flagged, setFlagged] = React.useState(false);
  const [forceTemplate, setForceTemplate] = React.useState(false);
  const [notConnected, setNotConnected] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    setBody("");
    setTemplateId("");
    setParams([]);
    setAiAssisted(false);
    setFlagged(false);
    setForceTemplate(false);
    setNotConnected(false);
    setFormError(null);
    setFieldErrors({});
  }, [open, contact.id]);

  const serviceWindow = useQuery({ queryKey: crmKeys.whatsappWindow(contact.id), queryFn: () => whatsAppWindow(contact.id), enabled: open && canSend });
  const templates = useQuery({ queryKey: crmKeys.whatsappTemplates, queryFn: listWhatsAppTemplates, enabled: open && canSend, staleTime: 60_000 });
  const approved = React.useMemo(() => approvedTemplates(templates.data?.results ?? []), [templates.data]);

  // A single approved template is the obvious choice; preselect it.
  React.useEffect(() => {
    if (approved.length === 1 && approved[0] && !templateId) setTemplateId(approved[0].id);
  }, [approved, templateId]);

  const connected = serviceWindow.data ? serviceWindow.data.connected && !notConnected : !notConnected;
  const optIn = serviceWindow.data?.opt_in ?? contact.whatsapp_opt_in;
  const textMode = Boolean(serviceWindow.data?.open) && !forceTemplate;

  const draft = useMutation({
    mutationFn: () => generateFollowUp({ entity_type: deal ? "deal" : "contact", entity_id: deal?.id ?? contact.id, tone: style, channel: "whatsapp" }),
    onSuccess: (result) => {
      setBody(result.draft.slice(0, MAX_WHATSAPP_TEXT));
      setAiAssisted(true);
      setFlagged(result.flagged_input);
      setFormError(null);
    },
    onError: (err) => setFormError(aiErrorMessage(err)),
  });

  const send = useMutation({
    mutationFn: () => {
      const input: WhatsAppSendInput = textMode
        ? { contact_id: contact.id, deal_id: deal?.id ?? null, message_type: "text", body: body.trim(), ai_assisted: aiAssisted }
        : { contact_id: contact.id, deal_id: deal?.id ?? null, message_type: "template", template_id: templateId, template_params: params };
      return sendWhatsApp(input);
    },
    onSuccess: async (message) => {
      await invalidate();
      toast({ tone: "success", title: "WhatsApp message queued", description: `To ${contact.name || contact.phone}.` });
      onSent?.(message);
      onOpenChange(false);
    },
    onError: (err) => {
      if (isProblem(err, "whatsapp_not_connected", 409)) {
        setNotConnected(true);
        return;
      }
      if (isProblem(err, "whatsapp_window_closed", 409)) {
        setForceTemplate(true);
        setFormError("The 24-hour window has closed since this dialog opened. Send an approved template instead.");
        void invalidate();
        return;
      }
      if (isProblem(err, "whatsapp_consent_required", 409)) {
        setFormError(errorMessage(err));
        return;
      }
      if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
        return;
      }
      toast({ tone: "error", title: "Could not send message", description: errorMessage(err) });
    },
  });

  if (!canSend) return null;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);
    if (textMode) {
      if (!body.trim()) {
        setFieldErrors({ body: "Write a message." });
        return;
      }
    } else {
      if (!templateId) {
        setFieldErrors({ template_id: "Choose an approved template." });
        return;
      }
      if (params.some((p) => !p.trim())) {
        setFieldErrors({ template_params: "Fill in every placeholder value." });
        return;
      }
    }
    send.mutate();
  };

  const sendDisabled = !connected || (!textMode && !optIn) || send.isPending || serviceWindow.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>WhatsApp message</DialogTitle>
            <DialogDescription>
              To {contact.name || "contact"} · {contact.phone || "no phone number"}
              {deal ? ` · linked to ${deal.name}` : ""}
            </DialogDescription>
          </DialogHeader>

          {serviceWindow.isPending ? (
            <SkeletonRows rows={3} />
          ) : serviceWindow.isError ? (
            <EmptyState
              title="Could not check the messaging window"
              description={errorMessage(serviceWindow.error)}
              action={
                <Button variant="secondary" onClick={() => serviceWindow.refetch()}>
                  Retry
                </Button>
              }
              className="py-6"
            />
          ) : !connected ? (
            <div role="alert" className="grid gap-2 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
              <span>WhatsApp is not connected for this workspace, so messages cannot be sent yet.</span>
              {canManage ? (
                <Link href={WHATSAPP_SETTINGS_HREF} className="font-medium underline underline-offset-4">
                  Connect the WhatsApp Business account in Settings → WhatsApp
                </Link>
              ) : (
                <span>Ask an administrator to connect the WhatsApp Business account.</span>
              )}
            </div>
          ) : (
            <>
              <FormError message={formError} />
              {textMode ? (
                <div className="grid gap-3">
                  <p className="flex items-start gap-1.5 text-xs text-fg-muted">
                    <Clock className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                    The customer messaged {serviceWindow.data?.last_inbound_at ? formatDateTime(serviceWindow.data.last_inbound_at) : "recently"}, so you can reply with free text
                    for 24 hours after that.
                  </p>
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
                      rows={5}
                      maxLength={MAX_WHATSAPP_TEXT}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={send.isPending || draft.isPending}
                      aria-invalid={fieldErrors.body ? true : undefined}
                      aria-describedby={fieldErrors.body ? `${baseId}-body-error` : undefined}
                    />
                    <div className="flex items-center justify-between gap-2">
                      {fieldErrors.body ? (
                        <p id={`${baseId}-body-error`} role="alert" className="text-xs text-danger">
                          {fieldErrors.body}
                        </p>
                      ) : (
                        <span />
                      )}
                      <span className="text-xs text-fg-subtle">
                        {body.length.toLocaleString()} / {MAX_WHATSAPP_TEXT.toLocaleString()}
                      </span>
                    </div>
                    {flagged ? (
                      <p className="flex items-start gap-1.5 text-xs text-warning">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        Some CRM notes contained suspicious instructions and were ignored while drafting.
                      </p>
                    ) : null}
                  </div>
                  {canAI ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="grid gap-1.5">
                        <Label htmlFor={`${baseId}-style`}>Style</Label>
                        <Select value={style} onValueChange={(v) => isStyle(v) && setStyle(v)} disabled={draft.isPending}>
                          <SelectTrigger id={`${baseId}-style`} className="h-8 w-40">
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
                      <Button type="button" variant="secondary" size="sm" onClick={() => draft.mutate()} loading={draft.isPending} disabled={send.isPending}>
                        <Sparkles /> Draft with AI
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="grid gap-3">
                  <p className="rounded-sm border border-border bg-bg-subtle px-3 py-2 text-xs text-fg-muted">
                    WhatsApp only allows free-text replies within 24 hours of the customer&apos;s last message. Outside that window you can send one of
                    the templates Meta has approved for this account, and only to contacts who have given consent.
                  </p>
                  {templates.isPending ? (
                    <SkeletonRows rows={2} />
                  ) : (
                    <WhatsAppTemplateFields
                      templates={approved}
                      templateId={templateId}
                      onTemplateChange={(id) => {
                        setTemplateId(id);
                        setParams([]);
                      }}
                      params={params}
                      onParamsChange={setParams}
                      errors={fieldErrors}
                      disabled={send.isPending}
                    />
                  )}
                  {!optIn ? (
                    <p role="alert" className="flex items-start gap-1.5 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {contact.name || "This contact"} has not opted in to WhatsApp messages. {CONSENT_HINT}
                    </p>
                  ) : null}
                </div>
              )}
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={send.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={send.isPending} disabled={sendDisabled}>
              {textMode ? "Send" : "Send template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
