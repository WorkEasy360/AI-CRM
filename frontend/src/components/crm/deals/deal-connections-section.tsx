"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Link2, Plus, Unlink } from "lucide-react";
import { StageBadge } from "@/components/crm/pipeline/deals-list";
import { Section } from "@/components/crm/record-page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { connectDeal, dealConnections, disconnectDeal, globalSearch } from "@/lib/api/crm";
import type { Deal } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { useDebounced } from "@/lib/crm/use-list-params";

/**
 * Deals connected to this one, usually in other pipelines (a sale and its onboarding project). Shown
 * on both deals; only deals the member may open are listed.
 */
export function DealConnectionsSection({ deal, editable }: { deal: Deal; editable: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [linking, setLinking] = React.useState(false);
  const links = useQuery({ queryKey: crmKeys.dealConnections(deal.id), queryFn: () => dealConnections(deal.id) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["crm", "deals"] });
  const unlink = useMutation({
    mutationFn: (connectionId: string) => disconnectDeal(deal.id, connectionId),
    onSuccess: refresh,
    onError: (err) => toast({ tone: "error", title: "Could not remove the link", description: errorMessage(err) }),
  });
  const items = links.data?.results ?? [];

  return (
    <Section
      title="Connected deals"
      actions={
        editable ? (
          <Button size="sm" variant="secondary" onClick={() => setLinking(true)}>
            <Plus /> Connect a deal
          </Button>
        ) : undefined
      }
    >
      {links.isPending ? (
        <SkeletonRows rows={2} />
      ) : links.isError ? (
        <p className="text-sm text-danger">{errorMessage(links.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState icon={<Link2 />} title="No connected deals" description="Connect deals that belong together, such as a sale and its delivery project." className="py-8" />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <ArrowLeftRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              <div className="min-w-0 flex-1">
                <Link prefetch={false} href={`/deals/${encodeURIComponent(c.deal.id)}`} className="block truncate font-medium text-fg hover:text-primary hover:underline">
                  {c.deal.name}
                </Link>
                <p className="truncate text-xs text-fg-muted">
                  {c.deal.pipeline.name}
                  {c.origin === "automation" ? " · created by automation" : ""}
                </p>
              </div>
              <StageBadge name={c.deal.stage.name} colorToken={c.deal.stage.kind === "won" ? "green" : c.deal.stage.kind === "lost" ? "red" : "blue"} />
              {c.deal.amount !== undefined ? <span className="w-28 text-right text-sm tabular-nums">{formatMoney(c.deal.amount, c.deal.currency)}</span> : null}
              {editable ? (
                <Button variant="ghost" size="icon-sm" aria-label={`Disconnect ${c.deal.name}`} onClick={() => unlink.mutate(c.id)} disabled={unlink.isPending}>
                  <Unlink />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {linking ? (
        <ConnectDialog
          deal={deal}
          exclude={new Set([deal.id, ...items.map((c) => c.deal.id)])}
          onClose={() => setLinking(false)}
          onConnected={async () => {
            await refresh();
            setLinking(false);
          }}
        />
      ) : null}
    </Section>
  );
}

function ConnectDialog({ deal, exclude, onClose, onConnected }: { deal: Deal; exclude: Set<string>; onClose: () => void; onConnected: () => Promise<void> }) {
  const { toast } = useToast();
  const [q, setQ] = React.useState("");
  const debounced = useDebounced(q, 250);
  const results = useQuery({
    queryKey: crmKeys.search(`deal:${debounced}`),
    queryFn: ({ signal }) => globalSearch(debounced, ["deal"], signal),
    enabled: debounced.trim().length > 1,
  });
  const connect = useMutation({
    mutationFn: (targetId: string) => connectDeal(deal.id, targetId),
    onSuccess: onConnected,
    onError: (err) => toast({ tone: "error", title: "Could not connect the deals", description: errorMessage(err) }),
  });
  const hits = (results.data?.results.deal ?? []).filter((h) => !exclude.has(h.id));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a deal</DialogTitle>
          <DialogDescription>The link shows on both deals.</DialogDescription>
        </DialogHeader>
        <Input autoFocus placeholder="Search deals by name…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search deals" maxLength={200} />
        <ul className="max-h-64 overflow-y-auto" aria-label="Matching deals">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-bg-subtle disabled:opacity-50"
                onClick={() => connect.mutate(h.id)}
                disabled={connect.isPending}
              >
                <span className="truncate font-medium">{h.title}</span>
                <span className="shrink-0 text-xs text-fg-muted">{h.meta}</span>
              </button>
            </li>
          ))}
          {debounced.trim().length > 1 && results.isSuccess && hits.length === 0 ? <li className="px-2 py-1.5 text-sm text-fg-subtle">No matching deals.</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
