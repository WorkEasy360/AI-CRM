"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Headset, Plus } from "lucide-react";
import { relativeTime } from "@/components/activities/activity-utils";
import { PRIORITY_BADGE, PRIORITY_LABELS, STATUS_BADGE_CLASS, STATUS_LABELS } from "@/components/helpdesk/ticket-meta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { helpdeskKeys, listTickets, ticketLabel } from "@/lib/api/helpdesk";
import { errorMessage } from "@/lib/api/problem";

/** A contact's support tickets (newest activity first), each opening in the Helpdesk. */
export function ContactTickets({ contactId, canCreate }: { contactId: string; canCreate: boolean }) {
  const params = { contact: contactId, sort: "-updated_at" };
  const tickets = useQuery({ queryKey: helpdeskKeys.list(params), queryFn: () => listTickets(params) });
  const newHref = `/helpdesk?new=1&contact=${encodeURIComponent(contactId)}`;
  if (tickets.isPending) return <SkeletonRows rows={3} />;
  if (tickets.isError) return <EmptyState title="Could not load tickets" description={errorMessage(tickets.error)} className="py-8" />;
  const rows = tickets.data.results;
  return (
    <div className="flex flex-col gap-2">
      {canCreate ? (
        <Button asChild size="sm" variant="secondary" className="w-fit">
          <Link href={newHref}>
            <Plus /> Create Ticket
          </Link>
        </Button>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState icon={<Headset />} title="No tickets" description="Support requests from this person will appear here." className="py-8" />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {rows.map((t) => (
            <li key={t.id}>
              <Link href={`/helpdesk?open=${encodeURIComponent(t.id)}`} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm hover:bg-bg-subtle">
                <span className="font-semibold tabular-nums text-primary">{ticketLabel(t)}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{t.subject}</span>
                <Badge variant={PRIORITY_BADGE[t.priority]}>{PRIORITY_LABELS[t.priority]}</Badge>
                <Badge className={STATUS_BADGE_CLASS[t.status]}>{STATUS_LABELS[t.status]}</Badge>
                <span className="text-xs text-fg-muted">{relativeTime(t.updated_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
