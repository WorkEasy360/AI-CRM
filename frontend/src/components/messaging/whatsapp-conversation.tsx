"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, Check, CheckCheck, Clock, FileText, MessageCircle, Sparkles } from "lucide-react";
import { isProblem, WHATSAPP_SETTINGS_HREF } from "@/components/messaging/messaging-errors";
import { MAX_WHATSAPP_TEXT, useInvalidateWhatsApp, WhatsAppDialog, type WhatsAppContact } from "@/components/messaging/whatsapp-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { listWhatsAppMessages, sendWhatsApp, whatsAppWindow } from "@/lib/api/crm";
import type { NamedRef, WhatsAppMessage, WhatsAppStatus } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn, formatDateTime } from "@/lib/utils";

const QUEUED_POLL_MS = 5000;

function StatusTicks({ status, error }: { status: WhatsAppStatus; error: string }) {
  const cls = "size-3.5";
  switch (status) {
    case "queued":
      return (
        <span className="inline-flex items-center gap-1" title="Queued">
          <Clock className={cls} aria-hidden /> <span className="sr-only">Queued</span>
        </span>
      );
    case "sent":
      return (
        <span className="inline-flex items-center gap-1" title="Sent">
          <Check className={cls} aria-hidden /> <span className="sr-only">Sent</span>
        </span>
      );
    case "delivered":
      return (
        <span className="inline-flex items-center gap-1" title="Delivered">
          <CheckCheck className={cls} aria-hidden /> <span className="sr-only">Delivered</span>
        </span>
      );
    case "read":
      return (
        <span className="inline-flex items-center gap-1 text-primary" title="Read">
          <CheckCheck className={cls} aria-hidden /> <span className="sr-only">Read</span>
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-danger" role="alert">
          <AlertCircle className={cls} aria-hidden /> Failed{error ? `: ${error}` : ""}
        </span>
      );
    default:
      return null;
  }
}

function Bubble({ message }: { message: WhatsAppMessage }) {
  const outbound = message.direction === "outbound";
  const when = message.received_at ?? message.sent_at ?? message.created_at;
  return (
    <li className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-md border px-3 py-2 text-sm shadow-sm sm:max-w-[70%]",
          outbound ? "border-primary/20 bg-primary-soft" : "border-border bg-surface",
        )}
      >
        {message.message_type === "template" ? (
          <p className="mb-1 inline-flex items-center gap-1 text-xs text-fg-subtle">
            <FileText className="size-3" aria-hidden /> Template{message.template ? ` · ${message.template.name}` : ""}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words">{message.body || <span className="text-fg-subtle">(empty message)</span>}</p>
        <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-xs text-fg-subtle">
          {message.ai_assisted ? (
            <span className="inline-flex items-center gap-1">
              <Sparkles className="size-3" aria-hidden /> AI-assisted
            </span>
          ) : null}
          {message.sent_by && outbound ? <span>{message.sent_by.display_name}</span> : null}
          <time dateTime={when}>{formatDateTime(when)}</time>
          {outbound ? <StatusTicks status={message.status} error={message.error_message} /> : null}
        </div>
      </div>
    </li>
  );
}

/** Chat-style WhatsApp thread with a contact, plus a composer footer. */
export function WhatsAppConversation({ contact, deal = null }: { contact: WhatsAppContact; deal?: NamedRef | null }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = can(active, "whatsapp.view");
  const canSend = can(active, "whatsapp.send");
  const canManage = can(active, "whatsapp.manage");
  const { toast } = useToast();
  const invalidate = useInvalidateWhatsApp(contact.id, deal?.id);
  const key = crmKeys.whatsappMessages("contact", contact.id);
  const messages = useCursorList<WhatsAppMessage>(key, (cursor) => listWhatsAppMessages("contact", contact.id, cursor), canView);
  const serviceWindow = useQuery({ queryKey: crmKeys.whatsappWindow(contact.id), queryFn: () => whatsAppWindow(contact.id), enabled: canView, staleTime: 30_000 });
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [quick, setQuick] = React.useState("");
  const [quickError, setQuickError] = React.useState<string | null>(null);

  // Provider status (sent/delivered/read) arrives via webhook shortly after queueing.
  const hasQueued = messages.items.some((m) => m.status === "queued");
  React.useEffect(() => {
    if (!hasQueued) return;
    const id = setInterval(() => void messages.refetch(), QUEUED_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasQueued]);

  const quickSend = useMutation({
    mutationFn: () => sendWhatsApp({ contact_id: contact.id, deal_id: deal?.id ?? null, message_type: "text", body: quick.trim() }),
    onSuccess: async () => {
      setQuick("");
      setQuickError(null);
      await invalidate();
    },
    onError: (err) => {
      if (isProblem(err, "whatsapp_window_closed", 409)) {
        setQuickError("The 24-hour window has closed. Send an approved template instead.");
        void invalidate();
        return;
      }
      if (isApiError(err) && err.isValidation) {
        setQuickError(err.fieldErrors().body ?? err.summary());
        return;
      }
      toast({ tone: "error", title: "Could not send message", description: errorMessage(err) });
    },
  });

  if (!canView) return null;

  const connected = serviceWindow.data?.connected ?? true;
  const windowOpen = Boolean(serviceWindow.data?.open);

  return (
    <section aria-label="WhatsApp conversation" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-subtle">
        <span>
          {contact.phone || "No phone number"}
          {contact.whatsapp_opt_in ? " · Consent recorded" : " · No consent recorded"}
        </span>
        {serviceWindow.data ? (
          windowOpen ? (
            <span className="inline-flex items-center gap-1 text-success">
              <Clock className="size-3.5" aria-hidden /> Free-text window open
              {serviceWindow.data.last_inbound_at ? ` · last reply ${formatDateTime(serviceWindow.data.last_inbound_at)}` : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden /> Window closed · templates only
            </span>
          )
        ) : null}
      </div>

      {messages.isPending ? (
        <SkeletonRows rows={3} />
      ) : messages.isError ? (
        <EmptyState
          title="Could not load the conversation"
          description={errorMessage(messages.error)}
          action={
            <Button variant="secondary" onClick={() => messages.refetch()}>
              Retry
            </Button>
          }
          className="py-8"
        />
      ) : messages.items.length === 0 ? (
        <EmptyState
          icon={<MessageCircle />}
          title="No WhatsApp messages yet"
          description="Messages exchanged with this contact through the workspace's WhatsApp Business number appear here. You can reply freely for 24 hours after the customer writes; otherwise send an approved template."
          action={canSend ? <Button onClick={() => setDialogOpen(true)}>Send a message</Button> : null}
          className="py-8"
        />
      ) : (
        <ol className="flex flex-col gap-2 rounded-md border border-border bg-bg-subtle/40 p-3">
          {messages.items.map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
          {messages.hasMore ? (
            <li className="flex justify-center pt-1">
              <Button variant="secondary" size="sm" onClick={() => messages.loadMore()} loading={messages.isLoadingMore}>
                Load more messages
              </Button>
            </li>
          ) : null}
        </ol>
      )}

      {canSend ? (
        !connected ? (
          <p className="text-xs text-fg-muted">
            WhatsApp is not connected for this workspace.{" "}
            {canManage ? (
              <Link href={WHATSAPP_SETTINGS_HREF} className="font-medium text-primary hover:underline">
                Connect it in Settings → WhatsApp
              </Link>
            ) : (
              "Ask an administrator to connect it."
            )}
          </p>
        ) : windowOpen ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (quick.trim()) quickSend.mutate();
            }}
          >
            <Textarea
              aria-label="Quick reply"
              placeholder="Write a reply…"
              rows={2}
              maxLength={MAX_WHATSAPP_TEXT}
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              disabled={quickSend.isPending}
              aria-invalid={quickError ? true : undefined}
            />
            {quickError ? (
              <p role="alert" className="text-xs text-danger">
                {quickError}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDialogOpen(true)}>
                Templates and AI draft…
              </Button>
              <Button type="submit" size="sm" disabled={!quick.trim()} loading={quickSend.isPending}>
                Send
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-end">
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <MessageCircle /> Send template message
            </Button>
          </div>
        )
      ) : null}

      <WhatsAppDialog open={dialogOpen} onOpenChange={setDialogOpen} contact={contact} deal={deal} />
    </section>
  );
}
