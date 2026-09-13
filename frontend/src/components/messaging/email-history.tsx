"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronUp, Loader2, Mail, Paperclip, RefreshCw, Reply, Sparkles } from "lucide-react";
import { EmailComposerDialog, type ComposerContact } from "@/components/messaging/email-composer-dialog";
import { formatBytes } from "@/components/messaging/messaging-errors";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { listRecordEmails } from "@/lib/api/crm";
import type { EmailMessage, EmailStatus, NamedRef, RelatedEntityType } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn, formatDateTime } from "@/lib/utils";

const STATUS_REFRESH_MS = 6000;

function statusBadge(status: EmailStatus): { label: string; variant: BadgeProps["variant"] } {
  switch (status) {
    case "queued":
      return { label: "Queued", variant: "neutral" };
    case "sent":
      return { label: "Sent", variant: "success" };
    case "failed":
      return { label: "Failed", variant: "danger" };
    case "received":
      return { label: "Received", variant: "primary" };
    default:
      return { label: status, variant: "neutral" };
  }
}

function messageTime(message: EmailMessage): string {
  return message.received_at ?? message.sent_at ?? message.created_at;
}

/** Emails logged on one record, newest first, with inline expansion and reply. */
export function EmailHistory({
  entity,
  recordId,
  contact = null,
  deal = null,
  company = null,
}: {
  entity: RelatedEntityType;
  recordId: string;
  contact?: ComposerContact | null;
  deal?: NamedRef | null;
  company?: NamedRef | null;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = can(active, "email.view");
  const canSend = can(active, "email.send");
  const queryClient = useQueryClient();
  const key = crmKeys.recordEmails(entity, recordId);
  const emails = useCursorList<EmailMessage>(key, (cursor) => listRecordEmails(entity, recordId, cursor), canView);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [composer, setComposer] = React.useState<{ open: boolean; replyTo: EmailMessage | null }>({ open: false, replyTo: null });
  const [refreshing, setRefreshing] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: key });
    } finally {
      setRefreshing(false);
    }
  };

  if (!canView) return null;

  const openComposer = (replyTo: EmailMessage | null) => setComposer({ open: true, replyTo });

  return (
    <section aria-label="Emails" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-fg-subtle">Messages sent from connected mailboxes and replies received on the same threads.</p>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh emails" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && "animate-spin")} />
          </Button>
          {canSend ? (
            <Button size="sm" onClick={() => openComposer(null)}>
              <Mail /> New email
            </Button>
          ) : null}
        </div>
      </div>

      {emails.isPending ? (
        <SkeletonRows rows={3} />
      ) : emails.isError ? (
        <EmptyState
          title="Could not load emails"
          description={errorMessage(emails.error)}
          action={
            <Button variant="secondary" onClick={() => emails.refetch()}>
              Retry
            </Button>
          }
          className="py-8"
        />
      ) : emails.items.length === 0 ? (
        <EmptyState
          icon={<Mail />}
          title="No emails yet"
          description="Emails you send from here, and replies to them, are logged on this record so the whole team sees the conversation."
          action={canSend ? <Button onClick={() => openComposer(null)}>Write an email</Button> : null}
          className="py-8"
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
          {emails.items.map((message) => (
            <EmailRow
              key={message.id}
              message={message}
              expanded={expanded === message.id}
              onToggle={() => setExpanded((current) => (current === message.id ? null : message.id))}
              onReply={canSend ? () => openComposer(message) : undefined}
            />
          ))}
        </ul>
      )}
      {emails.hasMore ? (
        <Button variant="secondary" size="sm" onClick={() => emails.loadMore()} loading={emails.isLoadingMore} className="self-center">
          Load more
        </Button>
      ) : null}

      <EmailComposerDialog
        open={composer.open}
        onOpenChange={(open) => setComposer((c) => ({ ...c, open }))}
        contact={contact}
        deal={deal}
        company={company}
        replyTo={composer.replyTo}
        onSent={() => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void queryClient.invalidateQueries({ queryKey: key }), STATUS_REFRESH_MS);
        }}
      />
    </section>
  );
}

function EmailRow({ message, expanded, onToggle, onReply }: { message: EmailMessage; expanded: boolean; onToggle: () => void; onReply?: () => void }) {
  const outbound = message.direction === "outbound";
  const { label, variant } = statusBadge(message.status);
  const bodyId = `email-${message.id}-body`;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-bg-subtle/60"
      >
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
            outbound ? "bg-primary-soft text-primary" : "bg-accent-soft text-accent",
          )}
          title={outbound ? "Sent" : "Received"}
        >
          {outbound ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownLeft className="size-3.5" aria-hidden />}
          <span className="sr-only">{outbound ? "Sent" : "Received"}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium text-fg">{message.subject || "(no subject)"}</span>
            <Badge variant={variant}>
              {message.status === "queued" ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
              {label}
            </Badge>
            {message.ai_assisted ? (
              <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
                <Sparkles className="size-3" aria-hidden /> AI-assisted
              </span>
            ) : null}
          </span>
          {!expanded ? <span className="mt-0.5 block truncate text-xs text-fg-muted">{message.snippet || message.body_text.slice(0, 140)}</span> : null}
          <span className="mt-0.5 block truncate text-xs text-fg-subtle">
            {message.from_address} → {message.to_addresses.join(", ") || "—"}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-fg-subtle">
          <time dateTime={messageTime(message)}>{formatDateTime(messageTime(message))}</time>
          {expanded ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
        </span>
      </button>
      {expanded ? (
        <div id={bodyId} className="grid gap-3 border-t border-border bg-bg-subtle/40 px-3 py-3 pl-12">
          {message.cc_addresses.length ? <p className="text-xs text-fg-subtle">Cc: {message.cc_addresses.join(", ")}</p> : null}
          {message.status === "failed" && message.error_message ? (
            <p role="alert" className="rounded-sm border border-danger/40 bg-danger-soft px-2 py-1 text-xs text-danger">
              Not delivered: {message.error_message}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap break-words text-sm">{message.body_text || <span className="text-fg-subtle">(empty message)</span>}</p>
          {message.attachments.length ? (
            <ul className="flex flex-wrap gap-2" aria-label="Attachments">
              {message.attachments.map((a) => (
                <li key={a.id} className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-2 py-1 text-xs">
                  <Paperclip className="size-3 text-fg-subtle" aria-hidden />
                  {a.filename} <span className="text-fg-subtle">({formatBytes(a.size_bytes)})</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-subtle">
            <span>{message.sent_by ? `Sent by ${message.sent_by.display_name}` : outbound ? "Sent" : "Received"}</span>
            {onReply ? (
              <Button variant="secondary" size="sm" onClick={onReply}>
                <Reply /> Reply
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
