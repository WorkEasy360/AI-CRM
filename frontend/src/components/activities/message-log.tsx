"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Mail, MessageCircle } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { listEmailInbox, listWhatsAppInbox } from "@/lib/api/crm";
import type { EmailMessage, WhatsAppMessage } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { formatDateTime } from "@/lib/utils";
import { useCursorList } from "@/lib/use-cursor-list";

const enc = encodeURIComponent;

type Channel = "whatsapp" | "email";
interface Row {
  id: string;
  inbound: boolean;
  summary: string;
  contact: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  when: string;
  by: string;
  status: string;
}

const STATUS_VARIANT: Record<string, BadgeProps["variant"]> = {
  received: "primary",
  queued: "neutral",
  sending: "neutral",
  sent: "success",
  delivered: "success",
  read: "success",
  failed: "danger",
  unconfirmed: "warning",
};

function whatsappRow(m: WhatsAppMessage): Row {
  return {
    id: m.id,
    inbound: m.direction === "inbound",
    summary: m.body || (m.template ? `Template: ${m.template.name}` : "WhatsApp message"),
    contact: m.contact ? { id: m.contact.id, name: m.contact.name } : null,
    deal: m.deal,
    when: m.received_at ?? m.sent_at ?? m.created_at,
    by: m.sent_by?.display_name ?? "",
    status: m.status,
  };
}

function emailRow(m: EmailMessage): Row {
  return {
    id: m.id,
    inbound: m.direction === "inbound",
    summary: m.subject || m.snippet || "(no subject)",
    contact: m.contact ? { id: m.contact.id, name: m.contact.name } : null,
    deal: m.deal,
    when: m.received_at ?? m.sent_at ?? m.created_at,
    by: m.sent_by?.display_name ?? "",
    status: m.status,
  };
}

/** The Activities page's WhatsApp / Emails tab: every conversation the member may see, newest first. */
export function MessageLog({ channel }: { channel: Channel }) {
  const list = useCursorList<WhatsAppMessage | EmailMessage>(crmKeys.messageInbox(channel), (cursor) =>
    channel === "whatsapp" ? listWhatsAppInbox(cursor) : listEmailInbox(cursor),
  );
  const rows = React.useMemo(
    () => list.items.map((m) => (channel === "whatsapp" ? whatsappRow(m as WhatsAppMessage) : emailRow(m as EmailMessage))),
    [list.items, channel],
  );
  const Icon = channel === "whatsapp" ? MessageCircle : Mail;
  const noun = channel === "whatsapp" ? "WhatsApp messages" : "emails";

  if (list.isPending) return <SkeletonRows rows={5} />;
  if (list.isError) {
    return <EmptyState title={`Could not load ${noun}`} description={errorMessage(list.error)} action={<Button variant="secondary" size="sm" onClick={() => list.refetch()}>Try again</Button>} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Icon />}
        title={`No ${noun} yet`}
        description={channel === "whatsapp" ? "Messages you send from a contact, and replies from your contacts, appear here." : "Emails you send from the CRM, and synced replies, appear here."}
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-sm">
      <table className="w-full text-sm">
        <caption className="sr-only">{channel === "whatsapp" ? "WhatsApp messages" : "Emails"}, newest first</caption>
        <thead className="border-b border-border text-left text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Activity
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Related to
            </th>
            <th scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
              Date
            </th>
            <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
              Owner
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="max-w-[22rem] px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="size-4 shrink-0 text-primary" aria-hidden />
                  {r.inbound ? <ArrowDownLeft className="size-3.5 shrink-0 text-fg-subtle" aria-label="Received" /> : <ArrowUpRight className="size-3.5 shrink-0 text-fg-subtle" aria-label="Sent" />}
                  <span className="truncate">{r.summary}</span>
                </span>
              </td>
              <td className="px-3 py-2">
                {r.contact ? (
                  <Link href={`/contacts/${enc(r.contact.id)}`} className="text-primary hover:underline">
                    {r.contact.name}
                  </Link>
                ) : r.deal ? (
                  <Link href={`/deals/${enc(r.deal.id)}`} className="text-primary hover:underline">
                    {r.deal.name}
                  </Link>
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-fg-muted">{formatDateTime(r.when)}</td>
              <td className="hidden px-3 py-2 text-fg-muted md:table-cell">{r.by || (r.inbound ? "Customer" : "—")}</td>
              <td className="px-3 py-2">
                <Badge variant={STATUS_VARIANT[r.status] ?? "neutral"} className="capitalize">
                  {r.status}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.hasMore ? (
        <div className="border-t border-border p-2 text-center">
          <Button variant="ghost" size="sm" loading={list.isLoadingMore} onClick={() => list.loadMore()}>
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
