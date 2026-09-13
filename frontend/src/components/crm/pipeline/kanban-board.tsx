"use client";

import * as React from "react";
import Link from "next/link";
import { Building2, CalendarDays, GripVertical, MoreHorizontal, User } from "lucide-react";
import { useMoveStage, type StageTarget } from "@/components/crm/deals/move-stage-dialog";
import { TagList } from "@/components/crm/tag-picker";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Board, BoardStage, Deal } from "@/lib/api/crm-types";
import { formatMoney, stageDotClass } from "@/lib/crm/format";
import { cn, formatDate } from "@/lib/utils";

const DRAG_MIME = "application/x-keel-deal";

interface PendingMove {
  stageId: string;
  deal: Deal;
}

/** Apply optimistic moves on top of the server board so cards render in their new column instantly. */
function applyPending(board: Board, pending: Record<string, PendingMove>): BoardStage[] {
  const ids = Object.keys(pending);
  if (ids.length === 0) return board.stages;
  return board.stages.map((stage) => {
    const kept = stage.deals.filter((d) => !(d.id in pending));
    const incoming = ids.filter((id) => pending[id]?.stageId === stage.id).map((id) => pending[id]!.deal);
    const removedCount = stage.deals.length - kept.length;
    const removedAmount = stage.deals.filter((d) => d.id in pending).reduce((sum, d) => sum + Number(d.amount_base || 0), 0);
    const addedAmount = incoming.reduce((sum, d) => sum + Number(d.amount_base || 0), 0);
    const total = Number(stage.total_amount_base || 0) - removedAmount + addedAmount;
    return {
      ...stage,
      deals: [...incoming, ...kept],
      deal_count: stage.deal_count - removedCount + incoming.length,
      total_amount_base: total.toFixed(2),
    };
  });
}

export function KanbanBoard({
  board,
  baseCurrency,
  canMove = true,
  isFetching,
}: {
  board: Board;
  baseCurrency: string;
  /** Whether the actor holds `deals.change_stage`; the API re-checks per deal. */
  canMove?: boolean;
  isFetching?: boolean;
}) {
  const [pending, setPending] = React.useState<Record<string, PendingMove>>({});
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<string | null>(null);

  const move = useMoveStage({
    onMutate: ({ deal, stage }) => {
      setPending((prev) => ({ ...prev, [deal.id]: { stageId: stage.id, deal: { ...deal, stage: { ...deal.stage, id: stage.id, name: stage.name, kind: stage.kind } } } }));
    },
    onSuccess: (updated, { deal }) => {
      // Keep the server copy (fresh version) until the refetched board replaces it.
      setPending((prev) => (prev[deal.id] ? { ...prev, [deal.id]: { stageId: updated.stage.id, deal: updated } } : prev));
    },
    onError: (_error, { deal }) => {
      setPending((prev) => {
        const next = { ...prev };
        delete next[deal.id];
        return next;
      });
    },
  });

  // Once the server board reflects a move, drop the optimistic override.
  React.useEffect(() => {
    setPending((prev) => {
      const next: Record<string, PendingMove> = {};
      let changed = false;
      for (const [id, entry] of Object.entries(prev)) {
        const server = board.stages.find((s) => s.deals.some((d) => d.id === id));
        if (server && server.id === entry.stageId) changed = true;
        else next[id] = entry;
      }
      return changed ? next : prev;
    });
  }, [board]);

  const stages = React.useMemo(() => applyPending(board, pending), [board, pending]);
  const targets: StageTarget[] = React.useMemo(() => board.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })), [board.stages]);
  const dealsById = React.useMemo(() => {
    const map = new Map<string, Deal>();
    for (const stage of stages) for (const deal of stage.deals) map.set(deal.id, deal);
    return map;
  }, [stages]);

  const dropOn = (stage: BoardStage, dealId: string) => {
    const deal = dealsById.get(dealId);
    if (!deal || deal.stage.id === stage.id) return;
    move.requestMove(deal, stage);
  };

  if (board.stages.length === 0) {
    return <p className="rounded-md border border-dashed border-border-strong bg-surface p-8 text-center text-sm text-fg-muted">This pipeline has no active stages yet.</p>;
  }

  return (
    <div className={cn("-mx-1 overflow-x-auto pb-3 transition-opacity", isFetching && "opacity-80")} aria-busy={isFetching || undefined}>
      <ol className="flex min-w-max items-start gap-3 px-1" aria-label="Pipeline stages">
        {stages.map((stage) => {
          const isOver = overStage === stage.id && dragging !== null;
          return (
            <li
              key={stage.id}
              className={cn(
                "flex w-72 shrink-0 flex-col rounded-md border bg-surface-sunken transition-colors",
                isOver ? "border-primary bg-primary-soft/40" : "border-border",
              )}
              onDragOver={(e) => {
                if (!canMove || !dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overStage !== stage.id) setOverStage(stage.id);
              }}
              onDragLeave={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOverStage((s) => (s === stage.id ? null : s));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain") || dragging;
                setOverStage(null);
                setDragging(null);
                if (id && canMove) dropOn(stage, id);
              }}
              data-testid={`column-${stage.id}`}
            >
              <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span className={cn("size-2.5 shrink-0 rounded-full", stageDotClass(stage.color_token))} aria-hidden />
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={stage.name}>
                  {stage.name}
                </h3>
                <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs font-medium text-fg-muted" aria-label={`${stage.deal_count} deals`}>
                  {stage.deal_count}
                </span>
              </header>
              <p className="px-3 pt-2 text-xs text-fg-subtle">{formatMoney(stage.total_amount_base, baseCurrency)}</p>
              <ul className="flex min-h-24 flex-col gap-2 p-2" aria-label={`${stage.name} deals`}>
                {stage.deals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    stages={targets}
                    canMove={canMove}
                    dragging={dragging === deal.id}
                    busy={move.pendingDealId === deal.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_MIME, deal.id);
                      e.dataTransfer.setData("text/plain", deal.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(deal.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOverStage(null);
                    }}
                    onMove={(target) => move.requestMove(deal, target)}
                  />
                ))}
                {stage.deals.length === 0 ? <li className="py-6 text-center text-xs text-fg-subtle">No deals</li> : null}
              </ul>
              {stage.has_more ? (
                <p className="border-t border-border px-3 py-2 text-xs text-fg-subtle">
                  +{Math.max(stage.deal_count - stage.deals.length, 1)} more — use the list view to see all
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {move.dialog}
    </div>
  );
}

function DealCard({
  deal,
  stages,
  canMove,
  dragging,
  busy,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  deal: Deal;
  stages: StageTarget[];
  canMove: boolean;
  dragging: boolean;
  busy: boolean;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onMove: (stage: StageTarget) => void;
}) {
  const who = deal.company?.name || deal.primary_contact?.name || "";
  return (
    <li
      className={cn(
        "group rounded-md border border-border bg-surface p-3 shadow-sm transition-opacity",
        canMove && "cursor-grab active:cursor-grabbing",
        (dragging || busy) && "opacity-50",
        deal.status === "won" && "border-l-4 border-l-success",
        deal.status === "lost" && "border-l-4 border-l-danger",
      )}
      draggable={canMove && !busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-busy={busy || undefined}
      data-testid={`deal-card-${deal.id}`}
    >
      <div className="flex items-start gap-1.5">
        {canMove ? <GripVertical className="mt-0.5 size-4 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" aria-hidden /> : null}
        <div className="min-w-0 flex-1">
          <Link href={`/deals/${encodeURIComponent(deal.id)}`} className="block truncate text-sm font-medium text-fg hover:text-primary hover:underline" draggable={false}>
            {deal.name}
          </Link>
          {who ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-fg-muted">
              {deal.company ? <Building2 className="size-3 shrink-0" aria-hidden /> : <User className="size-3 shrink-0" aria-hidden />}
              <span className="truncate">{who}</span>
            </p>
          ) : null}
        </div>
        {canMove ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-mr-1 -mt-1 shrink-0" aria-label={`Move ${deal.name} to another stage`} disabled={busy}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Move to…</DropdownMenuLabel>
              {stages
                .filter((s) => s.id !== deal.stage.id)
                .map((s) => (
                  <DropdownMenuItem key={s.id} onSelect={() => onMove(s)}>
                    {s.name}
                    {s.kind !== "open" ? <span className="ml-auto text-xs text-fg-subtle">{s.kind === "won" ? "Won" : "Lost"}</span> : null}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums">{formatMoney(deal.amount, deal.currency)}</span>
        {deal.expected_close_date ? (
          <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
            <CalendarDays className="size-3" aria-hidden />
            <time dateTime={deal.expected_close_date}>{formatDate(deal.expected_close_date)}</time>
          </span>
        ) : null}
      </div>
      {deal.tags.length > 0 || deal.owner ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <TagList tags={deal.tags} max={2} />
          {deal.owner ? (
            <span className="ml-auto" title={deal.owner.display_name}>
              <Avatar name={deal.owner.display_name} size="sm" aria-label={`Owner: ${deal.owner.display_name}`} />
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
