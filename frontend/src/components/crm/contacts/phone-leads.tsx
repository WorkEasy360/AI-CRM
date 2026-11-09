"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ListFilter, Search, Users } from "lucide-react";
import { CallLink, WhatsAppButton } from "@/components/crm/contact-actions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { listContacts } from "@/lib/api/crm";
import type { Contact, ListParams } from "@/lib/api/crm-types";
import { getDashboard } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import { dueLabel, formatDayMonth } from "@/lib/crm/due-date";
import { crmKeys } from "@/lib/crm/keys";
import { monthKey } from "@/lib/crm/periods";
import { useDebounced } from "@/lib/crm/use-list-params";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn } from "@/lib/utils";

const WhatsAppDialog = dynamic(() => import("@/components/messaging/whatsapp-dialog").then((m) => m.WhatsAppDialog), { ssr: false });

/** "Active" is the dashboard's definition: still being worked. "Converted" became a customer. */
const TABS = [
  { label: "All", lifecycle: undefined },
  { label: "Active", lifecycle: "lead,prospect,qualified" },
  { label: "Converted", lifecycle: "customer" },
] as const;

/** Each >= 4.5:1 for its letters on its tint. */
const TINTS = ["bg-brand-soft text-brand", "bg-accent-soft text-accent", "bg-warning-soft text-warning", "bg-success-soft text-success"];

function tintOf(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length]!;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

/** The next follow-up if there is one, otherwise when the lead came in. */
function whenOf(contact: Contact): { text: string; soon: boolean } {
  if (contact.next_activity_at) {
    const due = dueLabel(contact.next_activity_at);
    return { text: due.text, soon: due.tone === "today" || due.tone === "overdue" };
  }
  return { text: formatDayMonth(contact.created_at), soon: false };
}

/** The phone's Leads: everyone in the CRM, one thumb from a call or a WhatsApp. */
export function PhoneLeads({ params, setParam }: { params: ListParams; setParam: (key: string, value: string | undefined) => void }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canWhatsApp = hasPermission(active, "whatsapp.send");
  const [search, setSearch] = React.useState(params.q ?? "");
  const [messaging, setMessaging] = React.useState<Contact | null>(null);
  const lifecycle = params.lifecycle;
  // Held here, not in the URL: a delayed URL update would cancel a tap on a lead made just after typing.
  const q = useDebounced(search.trim());

  const apiParams = React.useMemo<ListParams>(() => {
    const out: ListParams = { sort: "-created_at" };
    if (q) out.q = q;
    if (lifecycle) out.lifecycle = lifecycle;
    return out;
  }, [q, lifecycle]);
  const list = useCursorList<Contact>(crmKeys.list("contacts", apiParams), (cursor) => listContacts(apiParams, cursor), true, {
    recordKey: (row) => crmKeys.record("contacts", row.id),
  });

  // The tab counts are the dashboard's own, over every lead the member may see.
  const period = monthKey();
  const stats = useQuery({
    queryKey: queryKeys.dashboard(period, undefined, 6, "all"),
    queryFn: () => getDashboard(period, undefined, 6, "all"),
    enabled: hasPermission(active, "dashboards.view"),
    staleTime: 60_000,
  });
  const leads = stats.data?.leads;
  const counts: Record<string, number | undefined> = {
    All: leads?.total,
    Active: leads?.active,
    Converted: leads?.by_status.find((s) => s.status === "customer")?.count,
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <h1 className="sr-only">Leads</h1>
      <div role="group" aria-label="Lead status" className="scroll-x flex gap-2">
        {TABS.map((tab) => {
          const selected = (lifecycle ?? undefined) === tab.lifecycle;
          const count = counts[tab.label];
          return (
            <button
              key={tab.label}
              type="button"
              aria-pressed={selected}
              onClick={() => setParam("lifecycle", tab.lifecycle)}
              className={cn("h-10 shrink-0 rounded-lg border px-3.5 text-sm font-semibold transition-colors", selected ? "border-brand bg-brand text-brand-fg shadow-sm" : "border-border bg-surface text-fg")}
            >
              {tab.label}
              {count !== undefined ? ` (${count.toLocaleString()})` : ""}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search leads..." aria-label="Search leads" className="h-11 pl-9" />
        </div>
        <Button asChild variant="secondary" size="icon" className="size-11 shrink-0">
          <Link href="/contacts?tab=people" aria-label="More filters and views">
            <ListFilter />
          </Link>
        </Button>
      </div>

      {list.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : list.isError ? (
        <EmptyState title="Could not load leads" description={errorMessage(list.error)} />
      ) : list.items.length === 0 ? (
        <EmptyState icon={<Users />} title={q || lifecycle ? "No leads match" : "No leads yet"} description={q || lifecycle ? "Try different keywords or another tab." : "Tap + at the top to add your first lead."} />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.items.map((contact) => {
            const name = contact.display_name || contact.email || "Unnamed lead";
            const when = whenOf(contact);
            return (
              <li key={contact.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-sm">
                <Link href={`/contacts/${encodeURIComponent(contact.id)}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-ring">
                  <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-full text-md font-bold", tintOf(contact.id))} aria-hidden>
                    {initialsOf(name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-fg">{name}</span>
                    <span className="block truncate text-sm text-fg-muted">{contact.phone || contact.company?.name || contact.email}</span>
                    <span className={cn("block truncate text-xs font-semibold", when.soon ? "text-brand" : "text-fg-muted")}>{when.text}</span>
                  </span>
                </Link>
                <span className="flex shrink-0 items-center gap-1.5">
                  <CallLink phone={contact.phone} name={name} />
                  {canWhatsApp ? <WhatsAppButton phone={contact.phone} name={name} onClick={() => setMessaging(contact)} /> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {list.hasMore ? (
        <Button variant="secondary" onClick={() => list.loadMore()}>
          Show more
        </Button>
      ) : null}

      {messaging?.phone ? (
        <WhatsAppDialog
          open
          onOpenChange={(open) => !open && setMessaging(null)}
          contact={{ id: messaging.id, name: messaging.display_name || messaging.email, phone: messaging.phone, whatsapp_opt_in: Boolean(messaging.whatsapp_opt_in) }}
        />
      ) : null}
    </div>
  );
}
