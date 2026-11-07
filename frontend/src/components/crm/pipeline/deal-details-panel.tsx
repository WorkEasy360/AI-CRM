"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, CalendarDays, CheckCircle2, Circle, ExternalLink } from "lucide-react";
import { useMoveStage, type StageTarget } from "@/components/crm/deals/move-stage-dialog";
import { FilesPanel } from "@/components/crm/files-panel";
import { NotesPanel } from "@/components/crm/notes-panel";
import { OwnerSelect } from "@/components/crm/owner-select";
import { QuickActions } from "@/components/crm/quick-actions";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { dealLines, getDeal, listRecordActivities, updateDeal } from "@/lib/api/crm";
import { DEAL_SOURCES, DEAL_SOURCE_LABELS, type Deal, type DealCard, type DealInput, type DealSource } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canReassign } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn, formatDate, formatDateTime } from "@/lib/utils";

type Tab = "activities" | "notes" | "files";
const NO_SOURCE = "__none__";

/**
 * The board's Deal Details pop-up: stage, the key facts edited in place, the deal's activities,
 * notes and files, quick actions and "Move to Next Stage". Every write goes through the deal APIs,
 * which re-check permissions and the version; the full deal page stays one click away.
 */
export function DealDetailsPanel({ dealId, stages, onClose }: { dealId: string | null; stages: StageTarget[]; onClose: () => void }) {
  return (
    <Dialog open={Boolean(dealId)} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="block max-h-[calc(100dvh-2rem)] max-w-[32rem] overflow-y-auto p-0">
        <DialogTitle className="sr-only">Deal Details</DialogTitle>
        <DialogDescription className="sr-only">The selected deal</DialogDescription>
        {dealId ? <DealDetails dealId={dealId} stages={stages} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DealDetails({ dealId, stages }: { dealId: string; stages: StageTarget[] }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = React.useState<Tab>("activities");
  const deal = useQuery({ queryKey: crmKeys.record("deals", dealId), queryFn: () => getDeal(dealId) });
  const move = useMoveStage();
  const canEdit = can(active, "deals.update");
  const canMove = can(active, "deals.change_stage");

  const save = useMutation({
    mutationFn: (input: DealInput) => updateDeal(dealId, deal.data?.version ?? 1, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(crmKeys.record("deals", dealId), saved);
      queryClient.invalidateQueries({ queryKey: ["crm", "deals"] });
    },
    onError: (err) => toast({ tone: "error", title: "Could not save the deal", description: errorMessage(err) }),
  });

  if (deal.isPending) return <div className="p-4"><SkeletonRows rows={6} /></div>;
  if (deal.isError) return <p role="alert" className="p-4 text-sm text-danger">{errorMessage(deal.error)}</p>;
  const d = deal.data;
  const card = d as unknown as DealCard;
  const index = stages.findIndex((s) => s.id === d.stage.id);
  const next = stages.slice(index + 1).find((s) => s.kind !== "lost") ?? null;

  return (
    <section aria-label="Deal Details" className="flex flex-col">
      <div className="border-b border-border px-4 pb-4 pt-4 pr-12">
        <h2 className="text-lg font-bold text-fg">Deal Details</h2>
        <div className="mt-3 flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand" aria-hidden>
            <Building2 className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-base font-bold text-fg">{d.name}</p>
            {d.company ? <p className="truncate text-sm text-fg-muted">{d.company.name}</p> : null}
            {canMove ? (
              <Select value={d.stage.id} onValueChange={(id) => { const target = stages.find((s) => s.id === id); if (target) move.requestMove(card, target); }}>
                <SelectTrigger className="mt-2 h-8 w-44 border-transparent bg-accent-soft font-medium text-accent" aria-label="Stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="mt-2 inline-flex rounded-md bg-accent-soft px-2 py-1 text-sm font-medium text-accent">{d.stage.name}</p>
            )}
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 border-b border-border px-4 py-3 text-sm">
        <dt className="text-fg-muted">Deal Value</dt>
        <dd>
          {canEdit && !d.amount_from_lines && d.amount !== undefined ? (
            <InlineAmount value={d.amount} currency={d.currency} onSave={(amount) => save.mutate({ amount })} />
          ) : (
            <span className="font-semibold">{formatMoney(d.amount, d.currency)}</span>
          )}
        </dd>
        <dt className="text-fg-muted">Expected Close</dt>
        <dd>
          {canEdit ? (
            <Input type="date" className="h-8 w-44" aria-label="Expected close" defaultValue={d.expected_close_date ?? ""} onBlur={(e) => { const value = e.target.value || null; if (value !== d.expected_close_date) save.mutate({ expected_close_date: value }); }} />
          ) : (
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4 text-fg-muted" aria-hidden />{d.expected_close_date ? formatDate(d.expected_close_date) : "—"}</span>
          )}
        </dd>
        <dt className="text-fg-muted">Owner</dt>
        <dd>
          {canReassign(active, "deals") ? (
            <OwnerSelect value={d.owner?.id} onChange={(owner) => owner !== d.owner?.id && save.mutate({ owner_id: owner })} />
          ) : (
            <span className="inline-flex items-center gap-2"><Avatar name={d.owner?.display_name} size="sm" />{d.owner?.display_name ?? "—"}</span>
          )}
        </dd>
        <dt className="text-fg-muted">Source</dt>
        <dd>
          {canEdit ? (
            <Select value={d.lead_source || NO_SOURCE} onValueChange={(v) => save.mutate({ lead_source: v === NO_SOURCE ? "" : (v as DealSource) })}>
              <SelectTrigger className="h-8 w-44" aria-label="Source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SOURCE}>Not set</SelectItem>
                {DEAL_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {DEAL_SOURCE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span>{d.lead_source ? DEAL_SOURCE_LABELS[d.lead_source] : "—"}</span>
          )}
        </dd>
        <dt className="text-fg-muted">Product</dt>
        <dd className="min-w-0"><DealProducts deal={d} /></dd>
      </dl>

      <div role="tablist" aria-label="Deal sections" className="grid grid-cols-3 gap-1 px-4 pt-3">
        {(
          [
            ["activities", "Activities"],
            ["notes", "Notes"],
            ["files", "Files"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={cn("h-9 rounded-md text-sm font-medium", tab === value ? "bg-brand text-brand-fg" : "text-fg hover:bg-bg-subtle")}>
            {label}
          </button>
        ))}
      </div>
      <div className="px-4 py-3">
        {tab === "activities" ? <DealActivities dealId={d.id} /> : tab === "notes" ? <NotesPanel entity="deal" recordId={d.id} /> : <FilesPanel entity="deal" recordId={d.id} />}
      </div>

      <div className="border-t border-border px-4 py-3">
        <QuickActions deal={d} />
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4">
        {canMove && next && d.status === "open" ? (
          <Button size="lg" onClick={() => move.requestMove(card, next)} loading={move.isPending}>
            Move to Next Stage <ArrowRight />
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="sm" className="text-fg-muted">
          <Link href={`/deals/${encodeURIComponent(d.id)}`}>
            Open full deal <ExternalLink />
          </Link>
        </Button>
      </div>
      {move.dialog}
    </section>
  );
}

function InlineAmount({ value, currency, onSave }: { value: string; currency: string; onSave: (amount: string) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  if (!editing) {
    return (
      <button type="button" className="font-semibold text-fg hover:text-primary hover:underline" onClick={() => { setDraft(value); setEditing(true); }} aria-label="Edit deal value">
        {formatMoney(value, currency)}
      </button>
    );
  }
  return (
    <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setEditing(false); if (/^\d{1,16}(\.\d{1,2})?$/.test(draft.trim()) && draft.trim() !== value) onSave(draft.trim()); }}>
      <Input autoFocus inputMode="decimal" className="h-8 w-32" aria-label="Deal value" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setEditing(false)} />
      <Button type="submit" size="sm" onMouseDown={(e) => e.preventDefault()}>Save</Button>
    </form>
  );
}

function DealProducts({ deal }: { deal: Deal }) {
  const lines = useQuery({ queryKey: crmKeys.dealLines(deal.id), queryFn: () => dealLines(deal.id), enabled: (deal.line_count ?? 0) > 0 });
  if ((deal.line_count ?? 0) === 0) return <Link href={`/deals/${encodeURIComponent(deal.id)}?tab=products`} className="text-primary hover:underline">Add a product</Link>;
  if (lines.isPending) return <span className="text-fg-subtle">Loading…</span>;
  const names = (lines.data?.results ?? []).map((l) => l.product.name);
  return <span className="block truncate" title={names.join(", ")}>{names.join(", ") || "—"}</span>;
}

/** Completed ones get a green check, the rest a hollow circle, newest first. */
function DealActivities({ dealId }: { dealId: string }) {
  const activities = useQuery({ queryKey: ["crm", "deals", dealId, "panel-activities"], queryFn: () => listRecordActivities("deal", dealId, { sort: "-start_at", limit: "6" }) });
  if (activities.isPending) return <SkeletonRows rows={3} />;
  if (activities.isError) return <p role="alert" className="text-sm text-danger">{errorMessage(activities.error)}</p>;
  const rows = activities.data.results;
  if (rows.length === 0) return <p className="py-4 text-center text-sm text-fg-muted">No activities yet. Use the actions below to log one.</p>;
  return (
    <ol className="flex flex-col gap-3" aria-label="Deal activities">
      {rows.map((a) => {
        const done = a.status === "completed";
        return (
          <li key={a.id} className="flex gap-2.5">
            {done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-label="Completed" /> : <Circle className="mt-0.5 size-5 shrink-0 text-success" aria-label="Open" />}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">{a.title}</span>
              {a.start_at ? <span className="block text-xs text-fg-muted">{formatDateTime(a.start_at)}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
