"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { KanbanSquare, List, Plus, Search, Settings2, X } from "lucide-react";
import { DealsList } from "@/components/crm/pipeline/deals-list";
import { KanbanBoard, type BoardSort } from "@/components/crm/pipeline/kanban-board";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import dynamic from "next/dynamic";
import { getBoard, getCompany, getContact, listPipelines } from "@/lib/api/crm";
import type { ListParams, Pipeline } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useWarmRecordForm } from "@/lib/crm/use-custom-fields";
import { useDebounced, useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

// The new-deal form is a click away, not part of the board: it is imported lazily and mounted only
// while it is open. `useWarmRecordForm` loads it, and the deal custom fields it renders, ahead of the
// click; leaving it mounted with `open={false}` downloaded both on every visit to the board.
const importDealForm = () => import("@/components/crm/deals/deal-form-dialog");
const DealFormDialog = dynamic(() => importDealForm().then((m) => m.DealFormDialog), { ssr: false });

const ALL = "__all__";
const URL_KEYS = ["pipeline", "view", "new", "company", "contact", "q", "owner", "status", "stage", "sort", "archived"] as const;
const BOARD_KEYS = ["q", "owner", "status"] as const;

const BOARD_SORTS: { value: BoardSort; label: string }[] = [
  { value: "recent", label: "Recently moved" },
  { value: "amount", label: "Amount high–low" },
  { value: "close", label: "Closing soonest" },
  { value: "name", label: "Name A–Z" },
];

function boardSortOf(value: string | undefined): BoardSort {
  return BOARD_SORTS.some((s) => s.value === value) ? (value as BoardSort) : "recent";
}

/**
 * The primary CRM screen: a pipeline chooser on the left (when there is more than one, or the
 * member can manage them), the Kanban board or the list view on the right.
 */
export function PipelinePage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const baseCurrency = active?.organization.base_currency ?? "USD";
  const canCreate = can(active, "deals.create");
  const canMove = can(active, "deals.change_stage");
  const canManagePipelines = can(active, "pipelines.manage");
  const showRisk = can(active, "ai.scores.view");

  const { params, setParam, setParams, clear } = useListParams(URL_KEYS);
  const view = params.view === "list" ? "list" : "board";
  const newOpen = params.new === "1";

  // `?new=1&company=<id>&contact=<id>` (from the record pages' quick actions) prefills the new-deal form.
  const prefillCompanyId = newOpen ? params.company : undefined;
  const prefillContactId = newOpen ? params.contact : undefined;
  const prefillCompany = useQuery({
    queryKey: crmKeys.record("companies", prefillCompanyId ?? ""),
    queryFn: () => getCompany(prefillCompanyId ?? ""),
    enabled: Boolean(prefillCompanyId),
    staleTime: 60_000,
  });
  const prefillContact = useQuery({
    queryKey: crmKeys.record("contacts", prefillContactId ?? ""),
    queryFn: () => getContact(prefillContactId ?? ""),
    enabled: Boolean(prefillContactId),
    staleTime: 60_000,
  });
  const formDefaults = React.useMemo(
    () => ({
      company: prefillCompanyId ? { id: prefillCompanyId, name: prefillCompany.data?.name ?? "" } : null,
      contact: prefillContactId ? { id: prefillContactId, name: prefillContact.data?.display_name || prefillContact.data?.email || "" } : null,
    }),
    [prefillCompanyId, prefillContactId, prefillCompany.data, prefillContact.data],
  );

  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), staleTime: 60_000 });
  const pipelineList = React.useMemo(() => pipelines.data?.results ?? [], [pipelines.data]);
  const selectedPipeline = React.useMemo(
    () => pipelineList.find((p) => p.id === params.pipeline) ?? pipelineList.find((p) => p.is_default) ?? pipelineList[0] ?? null,
    [pipelineList, params.pipeline],
  );
  const pipelineId = selectedPipeline?.id;

  const boardParams = React.useMemo<ListParams>(() => {
    const out: ListParams = {};
    for (const key of BOARD_KEYS) if (params[key]) out[key] = params[key];
    return out;
  }, [params]);

  // The board does not wait for the pipeline list: both requests leave together, saving a round trip
  // on the CRM's most-opened page. It is keyed on the *URL* pipeline rather than the resolved one so
  // that the key does not change when the list arrives - keying on `pipelineId` would start with
  // `undefined`, then refetch the identical board under a new key a moment later. With no `?pipeline=`
  // the API picks the default pipeline exactly as `selectedPipeline` does below.
  const board = useQuery({
    queryKey: crmKeys.board(params.pipeline, boardParams),
    queryFn: () => getBoard(params.pipeline, boardParams),
    enabled: view === "board",
    placeholderData: (prev) => prev,
  });

  const summary = React.useMemo(() => {
    if (!board.data) return null;
    let open = 0;
    let openAmount = 0;
    let total = 0;
    for (const stage of board.data.stages) {
      total += stage.deal_count;
      if (stage.kind === "open") {
        open += stage.deal_count;
        openAmount += Number(stage.total_amount_base || 0);
      }
    }
    return { open, openAmount, total };
  }, [board.data]);

  const warmForm = useWarmRecordForm("deal", importDealForm);
  const setNewOpen = (open: boolean) => (open ? setParam("new", "1") : setParams({ new: undefined, company: undefined, contact: undefined }));
  const selectPipeline = (id: string) => setParams({ pipeline: id, stage: undefined });
  const listFilterCount = Object.keys(params).filter((k) => ["status", "stage", "archived", "owner"].includes(k) || k.startsWith("custom.")).length;
  const showPanel = pipelineList.length > 1 || canManagePipelines;

  return (
    <div className="flex h-full min-h-0 gap-4">
      {showPanel && pipelines.isSuccess ? (
        <PipelinePanel pipelines={pipelineList} selectedId={pipelineId} onSelect={selectPipeline} canManage={canManagePipelines} />
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            {pipelines.isPending ? (
              <Skeleton className="h-6 w-40" />
            ) : (
              <h1 className="truncate text-lg font-semibold tracking-tight text-fg">{selectedPipeline?.name ?? "Pipeline"}</h1>
            )}
            {summary ? (
              <p className="text-xs text-fg-muted" aria-live="polite">
                {summary.open} open {summary.open === 1 ? "deal" : "deals"} · {formatMoney(summary.openAmount, baseCurrency)}
                {summary.total !== summary.open ? ` · ${summary.total} shown` : ""}
              </p>
            ) : null}
          </div>
          {pipelineList.length > 1 ? (
            <Select value={selectedPipeline?.id ?? ""} onValueChange={selectPipeline}>
              <SelectTrigger className={cn("h-8 w-48", showPanel && "xl:hidden")} aria-label="Pipeline">
                <SelectValue placeholder="Pipeline" />
              </SelectTrigger>
              <SelectContent>
                {pipelineList.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-bg-subtle p-0.5" role="group" aria-label="View">
              <ViewButton active={view === "board"} onClick={() => setParam("view", undefined)} icon={<KanbanSquare />} label="Kanban" />
              <ViewButton active={view === "list"} onClick={() => setParam("view", "list")} icon={<List />} label="List" />
            </div>
            {canCreate ? (
              <Button size="sm" onClick={() => setNewOpen(true)} onPointerEnter={warmForm} onFocus={warmForm} disabled={pipelineList.length === 0}>
                <Plus /> Deal
              </Button>
            ) : null}
          </div>
        </div>

        {pipelines.isError ? (
          <EmptyState title="Could not load pipelines" description={errorMessage(pipelines.error)} action={<Button variant="secondary" onClick={() => pipelines.refetch()}>Retry</Button>} />
        ) : pipelines.isSuccess && pipelineList.length === 0 ? (
          <EmptyState
            icon={<KanbanSquare />}
            title="No pipelines yet"
            description="Create a pipeline with stages before adding deals."
            action={
              canManagePipelines ? (
                <Button asChild>
                  <Link href="/settings/pipelines">Set up a pipeline</Link>
                </Button>
              ) : null
            }
          />
        ) : view === "list" ? (
          pipelines.isPending ? (
            // The list is scoped to the resolved pipeline. Mounted before the pipelines arrive it fetched
            // deals of every pipeline first (and showed them), then the selected pipeline's again.
            <SkeletonRows rows={6} />
          ) : (
            <DealsList
              params={{ ...params, pipeline: pipelineId }}
              setParam={setParam}
              setParams={setParams}
              clear={clear}
              activeFilterCount={listFilterCount}
              pipeline={selectedPipeline}
              onNewDeal={() => setNewOpen(true)}
              canCreate={canCreate}
            />
          )
        ) : (
          <>
            <BoardFilters params={params} setParam={setParam} onClear={() => setParams({ q: undefined, owner: undefined, status: undefined, sort: undefined })} />
            {board.isPending || pipelines.isPending ? (
              <BoardSkeleton />
            ) : board.isError ? (
              <EmptyState title="Could not load the board" description={errorMessage(board.error)} action={<Button variant="secondary" onClick={() => board.refetch()}>Retry</Button>} />
            ) : (
              <KanbanBoard board={board.data} baseCurrency={baseCurrency} canMove={canMove} showRisk={showRisk} isFetching={board.isFetching} sort={boardSortOf(params.sort)} />
            )}
          </>
        )}
      </div>

      {newOpen && canCreate ? (
        <DealFormDialog open onOpenChange={setNewOpen} pipelines={pipelineList} defaultPipelineId={pipelineId} defaults={formDefaults} />
      ) : null}
    </div>
  );
}

function PipelinePanel({
  pipelines,
  selectedId,
  onSelect,
  canManage,
}: {
  pipelines: Pipeline[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  canManage: boolean;
}) {
  return (
    <aside className="hidden w-44 shrink-0 xl:block" aria-label="Pipelines">
      <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Pipelines</p>
      <ul className="flex flex-col gap-0.5">
        {pipelines.map((p) => {
          const current = p.id === selectedId;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm font-medium transition-colors",
                  current ? "bg-primary-soft text-primary" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                )}
              >
                <KanbanSquare className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{p.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {canManage ? (
        <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
          <Button asChild variant="ghost" size="sm" className="justify-start text-fg-muted">
            <Link href="/settings/pipelines">
              <Plus /> Add pipeline
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="justify-start text-fg-muted">
            <Link href="/settings/pipelines">
              <Settings2 /> Edit stages
            </Link>
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

function ViewButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors [&_svg]:size-3.5",
        active ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function BoardFilters({ params, setParam, onClear }: { params: ListParams; setParam: (key: string, value: string | undefined) => void; onClear: () => void }) {
  const [draft, setDraft] = React.useState(params.q ?? "");
  const debounced = useDebounced(draft, 300);
  React.useEffect(() => {
    if ((params.q ?? "") !== debounced) setParam("q", debounced || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  React.useEffect(() => {
    if (params.q === undefined && draft !== "") setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.q]);

  const hasFilters = Boolean(params.q || params.owner || params.status || params.sort);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-60">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input aria-label="Search deals" placeholder="Search deals…" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 pl-8" maxLength={200} />
      </div>
      <Select value={params.owner === "me" ? "me" : "all"} onValueChange={(v) => setParam("owner", v === "me" ? "me" : undefined)}>
        <SelectTrigger className="h-8 w-32" aria-label="Owner filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All deals</SelectItem>
          <SelectItem value="me">My deals</SelectItem>
        </SelectContent>
      </Select>
      <Select value={params.status ?? ALL} onValueChange={(v) => setParam("status", v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-32" aria-label="Status filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any status</SelectItem>
          <SelectItem value="open">Open</SelectItem>
          <SelectItem value="won">Won</SelectItem>
          <SelectItem value="lost">Lost</SelectItem>
        </SelectContent>
      </Select>
      <Select value={boardSortOf(params.sort)} onValueChange={(v) => setParam("sort", v === "recent" ? undefined : v)}>
        <SelectTrigger className="h-8 w-40" aria-label="Sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BOARD_SORTS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={onClear} className="text-fg-muted">
          <X /> Clear
        </Button>
      ) : null}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden" role="status" aria-label="Loading board">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-72 w-64 shrink-0" />
      ))}
    </div>
  );
}
