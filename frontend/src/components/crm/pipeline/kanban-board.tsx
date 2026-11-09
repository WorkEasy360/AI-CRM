"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, CalendarDays, CheckCircle2, MoreHorizontal, Pencil, Plus, Settings2, User, XCircle } from "lucide-react";
import { CallLink, WhatsAppButton } from "@/components/crm/contact-actions";
import { weightedTotal } from "@/components/crm/deals/deal-helpers";
import { useMoveStage, type StageTarget } from "@/components/crm/deals/move-stage-dialog";
import { RiskBadge } from "@/components/crm/risk-badge";
import { useQuickCreate } from "@/components/shell/quick-create-provider";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { getBoardStage, updateDeal } from "@/lib/api/crm";
import type { Board, BoardStage, DealCard, ListParams } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { useWindowedList } from "@/lib/use-windowed-list";
import { defaultFollowUpTime, dueLabel, DUE_TONE_CLASS, formatDayMonth } from "@/lib/crm/due-date";
import { formatMoney, stageHue, stageTintStyle } from "@/lib/crm/format";
import { cn } from "@/lib/utils";

const WhatsAppDialog = dynamic(() => import("@/components/messaging/whatsapp-dialog").then((m) => m.WhatsAppDialog), { ssr: false });

const DRAG_MIME = "application/x-keel-deal";
/** Typical card height (with its gap) for windowing a column; cards vary a little around it. */
const CARD_HEIGHT = 172;
const PAGE = 200;

/** Client-side ordering inside each column; "recent" keeps the server order (most recently moved first). */
export type BoardSort = "recent" | "amount" | "close" | "name";

interface PendingMove {
  stageId: string;
  deal: DealCard;
}

function sortDeals(deals: DealCard[], sort: BoardSort): DealCard[] {
  if (sort === "recent") return deals;
  const copy = [...deals];
  if (sort === "amount") copy.sort((a, b) => Number(b.amount_base || 0) - Number(a.amount_base || 0));
  else if (sort === "name") copy.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "close") copy.sort((a, b) => (a.expected_close_date ?? "9999").localeCompare(b.expected_close_date ?? "9999"));
  return copy;
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
  showRisk = true,
  canWhatsApp = true,
  canFollowUp = true,
  canManageStages = false,
  isFetching,
  sort = "recent",
  filters = {},
  onOpenDeal,
  onAddDeal,
}: {
  board: Board;
  /** Open a card in the Deal Details panel; without it the card name links to the deal page. */
  onOpenDeal?: (deal: DealCard) => void;
  /** A column's "+ Add Deal": create a deal straight into that stage. */
  onAddDeal?: (stage: BoardStage) => void;
  /** The board's filters, re-sent when a column pages in more cards. */
  filters?: ListParams;
  baseCurrency: string;
  /** Whether the actor holds `deals.change_stage`; the API re-checks per deal. */
  canMove?: boolean;
  /** Whether the actor holds `ai.scores.view`; hides the risk dot otherwise. */
  showRisk?: boolean;
  /** Whether the actor holds `whatsapp.send`; the API re-checks. */
  canWhatsApp?: boolean;
  /** Whether the actor holds `activities.create`; the API re-checks. */
  canFollowUp?: boolean;
  /** Whether the actor holds `pipelines.manage`: offers "Edit stages" on the columns. */
  canManageStages?: boolean;
  isFetching?: boolean;
  sort?: BoardSort;
}) {
  const [pending, setPending] = React.useState<Record<string, PendingMove>>({});
  // Cards paged in beyond the first load, per column, and whether each column has still more.
  const [extra, setExtra] = React.useState<Record<string, DealCard[]>>({});
  const [more, setMore] = React.useState<Record<string, boolean>>({});
  const [loadingMore, setLoadingMore] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<DealCard | null>(null);
  // One composer for the whole board, loaded when first asked for, rather than one per card.
  const [messaging, setMessaging] = React.useState<DealCard | null>(null);
  const { open: openCreate } = useQuickCreate();
  const { toast } = useToast();
  React.useEffect(() => {
    setExtra({});
    setMore({});
  }, [board]);
  const merged = React.useMemo<Board>(
    () => ({
      ...board,
      stages: board.stages.map((s) => {
        const seen = new Set(s.deals.map((d) => d.id));
        const added = (extra[s.id] ?? []).filter((d) => !seen.has(d.id));
        return { ...s, deals: [...s.deals, ...added], has_more: s.id in more ? Boolean(more[s.id]) : s.has_more };
      }),
    }),
    [board, extra, more],
  );
  const loadMore = async (stage: BoardStage) => {
    setLoadingMore(stage.id);
    try {
      const page = await getBoardStage(stage.id, stage.deals.length, PAGE, filters);
      setExtra((prev) => ({ ...prev, [stage.id]: [...(prev[stage.id] ?? []), ...page.deals] }));
      setMore((prev) => ({ ...prev, [stage.id]: page.has_more }));
    } catch (error) {
      toast({ tone: "error", title: "Could not load more deals", description: errorMessage(error) });
    } finally {
      setLoadingMore(null);
    }
  };
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

  const stages = React.useMemo(() => applyPending(merged, pending).map((s) => ({ ...s, deals: sortDeals(s.deals, sort) })), [merged, pending, sort]);
  const targets: StageTarget[] = React.useMemo(() => board.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })), [board.stages]);
  const dealsById = React.useMemo(() => {
    const map = new Map<string, DealCard>();
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
    // Desktop: fills the locked page height (never below 18rem) and columns scroll inside. Phones and tablets:
    // natural height, so the page scrolls down and only the board scrolls sideways, snapping to stages.
    <div className={cn("relative -mx-1 snap-x snap-proximity overflow-x-auto overscroll-x-contain pb-2 transition-opacity lg:min-h-72 lg:flex-1 lg:snap-none", isFetching && "opacity-80")} aria-busy={isFetching || undefined}>
      <ol className="flex h-full w-max min-w-full items-stretch gap-3 px-1" aria-label="Pipeline stages">
        {stages.map((stage) => {
          const isOver = overStage === stage.id && dragging !== null;
          // Server-computed over every deal in the column (null when amounts are hidden from the member).
          const weighted =
            stage.kind !== "open" || stage.deal_count === 0
              ? null
              : stage.weighted_amount_base !== undefined
                ? stage.weighted_amount_base
                : stage.has_more
                  ? null
                  : weightedTotal(stage.deals);
          return (
            <li
              key={stage.id}
              className={cn(
                // Phones show two stages side by side, tablets one and a peek of the next, and desktop shares
                // the width between the stages.
                "flex w-[min(17rem,calc(100vw-4rem))] shrink-0 snap-start scroll-ml-1 flex-col rounded-lg transition-colors max-md:w-[calc(50vw-1.375rem)] lg:w-[12.75rem] lg:grow",
                isOver && "bg-primary-soft/40 ring-2 ring-primary",
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
              <header className="rounded-lg px-3 pb-2 pt-2.5" style={stageTintStyle(stage.color_token)}>
                <div className="flex min-w-0 items-center justify-between gap-1">
                  <h3 className="min-w-0 truncate text-md font-bold text-fg" title={stage.name}>
                    {stage.name}
                    <span aria-hidden className="font-medium md:hidden"> ({stage.deal_count})</span>
                  </h3>
                  <ColumnMenu stage={stage} weighted={weighted === null ? null : formatMoney(weighted, baseCurrency)} onAddDeal={onAddDeal} canManageStages={canManageStages} />
                </div>
                <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1 text-sm font-medium tabular-nums text-fg-muted">
                  <span aria-label={`${stage.deal_count} deals`} className="max-md:sr-only">
                    {stage.deal_count} {stage.deal_count === 1 ? "Deal" : "Deals"}
                  </span>
                  {stage.total_amount_base !== null ? (
                    <>
                      <span aria-hidden className="max-md:hidden">•</span>
                      <span className="min-w-0 truncate max-md:font-bold max-md:text-fg">{formatMoney(stage.total_amount_base, baseCurrency)}</span>
                    </>
                  ) : null}
                </p>
                {weighted !== null ? <p className="sr-only">Weighted {formatMoney(weighted, baseCurrency)}</p> : null}
              </header>
              <ColumnCards
                stage={stage}
                render={(deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    stages={targets}
                    canMove={canMove}
                    showRisk={showRisk}
                    canWhatsApp={canWhatsApp}
                    canFollowUp={canFollowUp}
                    onWhatsApp={() => setMessaging(deal)}
                    onFollowUp={() =>
                      openCreate("task", {
                        deal: { id: deal.id, name: deal.name },
                        contact: deal.primary_contact ? { id: deal.primary_contact.id, name: deal.primary_contact.name } : null,
                        company: deal.company,
                        title: `Follow up: ${deal.name}`,
                        start_at: defaultFollowUpTime(),
                      })
                    }
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
                    onEdit={() => setEditing(deal)}
                    onOpen={onOpenDeal ? () => onOpenDeal(deal) : undefined}
                  />
                )}
              />
              {stage.has_more ? (
                <button
                  type="button"
                  className="border-t border-border px-2.5 py-1.5 text-left text-xs text-primary hover:underline disabled:text-fg-subtle"
                  onClick={() => loadMore(stage)}
                  disabled={loadingMore === stage.id}
                >
                  {loadingMore === stage.id ? "Loading…" : `Show ${Math.min(PAGE, Math.max(stage.deal_count - stage.deals.length, 1))} more`}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {move.dialog}
      {editing ? <QuickEditDialog deal={editing} onClose={() => setEditing(null)} /> : null}
      {messaging?.primary_contact?.phone ? (
        <WhatsAppDialog
          open
          onOpenChange={(open) => !open && setMessaging(null)}
          deal={{ id: messaging.id, name: messaging.name }}
          contact={{
            id: messaging.primary_contact.id,
            name: messaging.primary_contact.name,
            phone: messaging.primary_contact.phone,
            whatsapp_opt_in: Boolean(messaging.primary_contact.whatsapp_opt_in),
          }}
        />
      ) : null}
    </div>
  );
}

/** Display text for a card-layout value (plain value, reference or member). */
function layoutText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(layoutText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const v = value as { name?: string; display_name?: string };
    return v.name ?? v.display_name ?? "";
  }
  return String(value);
}

/** A column's cards, windowed: a column of hundreds of deals keeps only the visible cards in the DOM. */
function ColumnCards({ stage, render }: { stage: BoardStage; render: (deal: DealCard) => React.ReactNode }) {
  const win = useWindowedList({ count: stage.deals.length, itemHeight: CARD_HEIGHT, enabled: stage.deals.length > 40 });
  return (
    <ul
      ref={win.ref as React.RefObject<HTMLUListElement>}
      className="mt-2 flex min-h-20 flex-1 flex-col gap-2 overflow-y-auto pb-1"
      aria-label={`${stage.name} deals`}
    >
      {win.padTop ? <li aria-hidden style={{ height: win.padTop, flexShrink: 0 }} /> : null}
      {stage.deals.slice(win.start, win.end).map(render)}
      {win.padBottom ? <li aria-hidden style={{ height: win.padBottom, flexShrink: 0 }} /> : null}
      {stage.deals.length === 0 ? <li className="py-5 text-center text-xs text-fg-subtle">No deals</li> : null}
    </ul>
  );
}

/** Inline edit from the card: name, amount and expected close, versioned like any edit. */
function QuickEditDialog({ deal, onClose }: { deal: DealCard; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = React.useState(deal.name);
  const [amount, setAmount] = React.useState(deal.amount);
  const [close, setClose] = React.useState(deal.expected_close_date ?? "");
  const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true);
    const input: { name?: string; amount?: string; expected_close_date?: string | null } = {};
    if (name.trim() !== deal.name) input.name = name.trim();
    if (amount !== deal.amount) input.amount = amount;
    if ((close || null) !== deal.expected_close_date) input.expected_close_date = close || null;
    try {
      if (Object.keys(input).length) await updateDeal(deal.id, deal.version, input);
      await qc.invalidateQueries({ queryKey: ["crm", "deals"] });
      onClose();
    } catch (error) {
      const conflict = isApiError(error) && error.status === 409;
      toast({ tone: "error", title: conflict ? "This deal changed meanwhile" : "Could not save the deal", description: errorMessage(error) });
      if (conflict) await qc.invalidateQueries({ queryKey: ["crm", "deals"] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit deal</DialogTitle>
          <DialogDescription>Changes save straight to the deal.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qe-name">Name</Label>
            <Input id="qe-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} required />
          </div>
          {deal.amount !== undefined ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="qe-amount">Amount ({deal.currency})</Label>
              <Input id="qe-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="qe-close">Expected close</Label>
            <Input id="qe-close" type="date" value={close} onChange={(e) => setClose(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A column's options: its weighted forecast, adding a deal straight into it, and the stage setup. */
function ColumnMenu({
  stage,
  weighted,
  onAddDeal,
  canManageStages,
}: {
  stage: BoardStage;
  weighted: string | null;
  onAddDeal?: (stage: BoardStage) => void;
  canManageStages: boolean;
}) {
  if (!weighted && !onAddDeal && !canManageStages) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="-mr-1.5 size-8 shrink-0 max-lg:size-11" aria-label={`${stage.name} options`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {weighted ? <DropdownMenuLabel>Weighted {weighted}</DropdownMenuLabel> : null}
        {onAddDeal ? (
          <DropdownMenuItem onSelect={() => onAddDeal(stage)}>
            <Plus /> Add Deal
          </DropdownMenuItem>
        ) : null}
        {canManageStages ? (
          <DropdownMenuItem asChild>
            <Link href="/settings/pipelines">
              <Settings2 /> Edit stages
            </Link>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DealCard({
  deal,
  stages,
  canMove,
  showRisk,
  canWhatsApp,
  canFollowUp,
  dragging,
  busy,
  onDragStart,
  onDragEnd,
  onMove,
  onEdit,
  onOpen,
  onWhatsApp,
  onFollowUp,
}: {
  deal: DealCard;
  onOpen?: () => void;
  stages: StageTarget[];
  canMove: boolean;
  showRisk: boolean;
  canWhatsApp: boolean;
  canFollowUp: boolean;
  dragging: boolean;
  busy: boolean;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onMove: (stage: StageTarget) => void;
  onEdit: () => void;
  onWhatsApp: () => void;
  onFollowUp: () => void;
}) {
  const person = deal.primary_contact?.name || deal.company?.name || "";
  const open = deal.status === "open";
  const phone = deal.primary_contact?.phone;
  const due = open && deal.next_activity_at ? dueLabel(deal.next_activity_at) : null;
  return (
    <li
      className={cn("rounded-lg border border-border bg-surface p-3 shadow-sm transition-opacity", canMove && "cursor-grab active:cursor-grabbing", (dragging || busy) && "opacity-50")}
      draggable={canMove && !busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-busy={busy || undefined}
      data-testid={`deal-card-${deal.id}`}
    >
      <div className="flex items-start gap-1.5">
        <Building2 className="mt-0.5 size-4 shrink-0" style={{ color: stageHue(deal.stage.color_token) }} aria-hidden />
        <div className="min-w-0 flex-1">
          {onOpen ? (
            <button type="button" onClick={onOpen} className="block w-full truncate text-left text-sm font-semibold text-fg hover:text-primary hover:underline" draggable={false} title={deal.company?.name ? `${deal.name} (${deal.company.name})` : deal.name}>
              {deal.name}
            </button>
          ) : (
            <Link prefetch={false} href={`/deals/${encodeURIComponent(deal.id)}`} className="block truncate text-sm font-semibold text-fg hover:text-primary hover:underline" draggable={false}>
              {deal.name}
            </Link>
          )}
        </div>
        {canMove ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-mr-1.5 -mt-1 size-7 shrink-0 max-lg:size-11 max-md:-mr-2 max-md:size-8" aria-label={`Move ${deal.name} to another stage`} disabled={busy}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil /> Edit details…
              </DropdownMenuItem>
              {open && canFollowUp ? (
                // The card's Follow-up button has no room on a phone, so it moves here.
                <DropdownMenuItem onSelect={onFollowUp} className="md:hidden">
                  <CalendarDays /> Add follow-up
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
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

      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-md font-bold tabular-nums text-fg" title={`${deal.probability}% probability${deal.probability_overridden ? ", set by hand" : ""}`}>
          {formatMoney(deal.amount, deal.currency)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {deal.status === "won" ? (
            <Badge variant="success">
              <CheckCircle2 className="size-3" aria-hidden /> Won
            </Badge>
          ) : deal.status === "lost" ? (
            <Badge variant="danger">
              <XCircle className="size-3" aria-hidden /> Lost
            </Badge>
          ) : (
            <>
              {deal.priority === "high" ? <Badge variant="danger">High</Badge> : null}
              {showRisk ? <RiskBadge compact level={deal.risk_level} /> : null}
            </>
          )}
        </span>
      </div>

      <div className="mt-1.5 flex min-h-5 items-center gap-1.5 text-xs text-fg-muted">
        {person ? (
          <>
            {deal.primary_contact ? <User className="size-3.5 shrink-0" aria-hidden /> : <Building2 className="size-3.5 shrink-0" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{person}</span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {deal.owner ? <Avatar name={deal.owner.display_name} size="sm" className="size-5 shrink-0 text-[11px] max-md:hidden" title={`Owner: ${deal.owner.display_name}`} aria-label={`Owner: ${deal.owner.display_name}`} /> : null}
      </div>

      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
        <CalendarDays className="size-3.5 shrink-0" aria-hidden />
        {!open && deal.closed_at ? (
          <span className="truncate">
            Closed: <time dateTime={deal.closed_at}>{formatDayMonth(deal.closed_at)}</time>
          </span>
        ) : due && deal.next_activity_at ? (
          <span className="min-w-0 truncate" title={deal.next_activity_title || undefined}>
            Follow-up:{" "}
            <time dateTime={deal.next_activity_at} className={cn("rounded-sm px-1 font-medium", due.tone !== "later" && DUE_TONE_CLASS[due.tone])}>
              {due.text}
            </time>
            {deal.next_activity_title ? <span className="sr-only"> {deal.next_activity_title}</span> : null}
          </span>
        ) : open ? (
          <span className="truncate text-danger">No next step</span>
        ) : null}
      </p>

      {deal.extra?.length ? (
        <dl className="mt-1 flex flex-col gap-0.5 text-xs">
          {deal.extra.map((e) => {
            const text = layoutText(e.value);
            return text ? (
              <div key={e.key} className="flex min-w-0 gap-1">
                <dt className="shrink-0 text-fg-subtle">{e.label}</dt>
                <dd className="truncate text-fg-muted">{text}</dd>
              </div>
            ) : null;
          })}
        </dl>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1.5">
        <CallLink phone={phone} name={person || deal.name} />
        {canWhatsApp ? <WhatsAppButton phone={phone} name={person || deal.name} onClick={onWhatsApp} /> : null}
        {open && canFollowUp ? (
          <button
            type="button"
            onClick={onFollowUp}
            className={cn(
              "inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-border-strong bg-surface px-1.5 text-xs font-medium text-fg transition-colors hover:border-brand hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-ring lg:h-8",
              canMove && "max-md:hidden",
            )}
            aria-label={`Add a follow-up for ${deal.name}`}
          >
            <CalendarDays className="size-3.5 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">Follow-up</span>
          </button>
        ) : null}
      </div>
    </li>
  );
}
