"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ListTodo, Phone, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listDeals, listRecordActivities } from "@/lib/api/crm";
import type { Activity, ActivityKind, Contact, Deal } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { formatDate, formatDateTime } from "@/lib/utils";

const enc = encodeURIComponent;
const KIND_ICON: Record<ActivityKind, React.ComponentType<{ className?: string }>> = { task: ListTodo, call: Phone, meeting: CalendarDays };

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-surface shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {action}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** The 360° overview: the contact's current deal and what happened most recently. */
export function ContactOverview({ contact, newDealHref }: { contact: Contact; newDealHref: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  return (
    <div className="grid gap-4">
      {can(active, "deals.view") ? <DealDetails contact={contact} newDealHref={newDealHref} canCreate={can(active, "deals.create")} /> : null}
      {can(active, "activities.view") ? <RecentActivities contactId={contact.id} /> : null}
    </div>
  );
}

function DealDetails({ contact, newDealHref, canCreate }: { contact: Contact; newDealHref: string; canCreate: boolean }) {
  const params = React.useMemo(() => ({ contact: contact.id, status: "open", sort: "-updated_at", limit: "1" }), [contact.id]);
  const query = useQuery({ queryKey: crmKeys.list("deals", params), queryFn: () => listDeals(params) });
  const deal: Deal | undefined = query.data?.results[0];
  return (
    <Card
      title="Deal Details"
      action={
        canCreate ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={newDealHref}>
              <Plus /> New deal
            </Link>
          </Button>
        ) : null
      }
    >
      {query.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : !deal ? (
        <p className="py-2 text-sm text-fg-muted">No open deal with this contact.</p>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <Link href={`/deals/${enc(deal.id)}`} className="font-semibold text-fg hover:text-primary hover:underline">
                {deal.name}
              </Link>
              <p className="text-xs text-fg-muted">{deal.stage.name}</p>
            </div>
            <span className="text-lg font-bold tabular-nums text-fg">{formatMoney(deal.amount, deal.currency)}</span>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-fg-subtle">Pipeline</dt>
              <dd className="truncate font-medium text-fg">{deal.pipeline.name}</dd>
            </div>
            <div>
              <dt className="text-fg-subtle">Expected close</dt>
              <dd className="font-medium text-fg">{deal.expected_close_date ? formatDate(deal.expected_close_date) : "—"}</dd>
            </div>
            <div>
              <dt className="text-fg-subtle">Probability</dt>
              <dd className="font-medium tabular-nums text-fg">{deal.probability}%</dd>
            </div>
          </dl>
        </div>
      )}
    </Card>
  );
}

function RecentActivities({ contactId }: { contactId: string }) {
  const params = React.useMemo(() => ({ sort: "-start_at", limit: "4" }), []);
  const query = useQuery({
    queryKey: crmKeys.recordActivities("contact", contactId, params),
    queryFn: () => listRecordActivities("contact", contactId, params),
  });
  const items: Activity[] = query.data?.results ?? [];
  return (
    <Card title="Recent Activities">
      {query.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : items.length === 0 ? (
        <p className="py-2 text-sm text-fg-muted">No activities yet. Log a call or schedule a meeting from the Activities tab.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((a) => {
            const Icon = KIND_ICON[a.kind] ?? ListTodo;
            return (
              <li key={a.id} className="flex items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary" aria-hidden>
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{a.title}</p>
                  <p className="text-xs text-fg-muted">{formatDateTime(a.completed_at ?? a.start_at)}</p>
                </div>
                {a.status === "completed" ? <Badge variant="success">Done</Badge> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
