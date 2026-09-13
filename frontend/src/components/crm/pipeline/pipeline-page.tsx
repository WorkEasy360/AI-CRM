"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { KanbanSquare, List, Plus, Search, Settings2, X } from "lucide-react";
import { DealFormDialog } from "@/components/crm/deals/deal-form-dialog";
import { DealsList } from "@/components/crm/pipeline/deals-list";
import { KanbanBoard } from "@/components/crm/pipeline/kanban-board";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getBoard, listPipelines } from "@/lib/api/crm";
import type { ListParams } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useDebounced, useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const ALL = "__all__";
const URL_KEYS = ["pipeline", "view", "new", "q", "owner", "status", "stage", "sort", "archived"] as const;
const BOARD_KEYS = ["q", "owner", "status"] as const;

export function PipelinePage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const baseCurrency = active?.organization.base_currency ?? "USD";
  const canCreate = can(active, "deals.create");
  const canMove = can(active, "deals.change_stage");
  const canManagePipelines = can(active, "pipelines.manage");

  const { params, setParam, setParams, clear } = useListParams(URL_KEYS);
  const view = params.view === "list" ? "list" : "board";
  const newOpen = params.new === "1";

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

  const board = useQuery({
    queryKey: crmKeys.board(pipelineId, boardParams),
    queryFn: () => getBoard(pipelineId, boardParams),
    enabled: view === "board" && pipelines.isSuccess,
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

  const setNewOpen = (open: boolean) => setParam("new", open ? "1" : undefined);

  const listFilterCount = Object.keys(params).filter((k) => ["status", "stage", "archived", "owner"].includes(k) || k.startsWith("custom.")).length;

  return (
    <div>
      <PageHeader
        title="Pipeline"
        description={selectedPipeline ? `${selectedPipeline.name}${summary ? ` · ${summary.open} open · ${formatMoney(summary.openAmount, baseCurrency)}` : ""}` : "Deals by stage."}
        actions={
          <>
            {canManagePipelines ? (
              <Button asChild variant="ghost" size="sm">
                <Link href="/settings/pipelines">
                  <Settings2 /> Manage pipelines
                </Link>
              </Button>
            ) : null}
            {canCreate ? (
              <Button onClick={() => setNewOpen(true)} disabled={pipelineList.length === 0}>
                <Plus /> New deal
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {pipelines.isPending ? (
          <Skeleton className="h-9 w-48" />
        ) : pipelineList.length > 1 ? (
          <Select value={selectedPipeline?.id ?? ""} onValueChange={(v) => setParams({ pipeline: v, stage: undefined })}>
            <SelectTrigger className="w-full sm:w-56" aria-label="Pipeline">
              <SelectValue placeholder="Pipeline" />
            </SelectTrigger>
            <SelectContent>
              {pipelineList.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  {p.is_default ? " (default)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="inline-flex h-9 items-center gap-1 rounded-sm bg-bg-subtle p-1" role="group" aria-label="View">
          <ViewButton active={view === "board"} onClick={() => setParam("view", undefined)} icon={<KanbanSquare />} label="Board" />
          <ViewButton active={view === "list"} onClick={() => setParam("view", "list")} icon={<List />} label="List" />
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
        <DealsList
          params={{ ...params, pipeline: pipelineId }}
          setParam={setParam}
          clear={clear}
          activeFilterCount={listFilterCount}
          pipeline={selectedPipeline}
          onNewDeal={() => setNewOpen(true)}
          canCreate={canCreate}
        />
      ) : (
        <>
          <BoardFilters params={params} setParam={setParam} onClear={() => setParams({ q: undefined, owner: undefined, status: undefined })} />
          {board.isPending || pipelines.isPending ? (
            <BoardSkeleton />
          ) : board.isError ? (
            <EmptyState title="Could not load the board" description={errorMessage(board.error)} action={<Button variant="secondary" onClick={() => board.refetch()}>Retry</Button>} />
          ) : (
            <>
              {summary ? (
                <p className="mb-3 text-xs text-fg-subtle" aria-live="polite">
                  {summary.total} {summary.total === 1 ? "deal" : "deals"} shown · {summary.open} open worth {formatMoney(summary.openAmount, baseCurrency)}
                </p>
              ) : null}
              <KanbanBoard board={board.data} baseCurrency={baseCurrency} canMove={canMove} isFetching={board.isFetching} />
            </>
          )}
        </>
      )}

      <DealFormDialog open={newOpen && canCreate} onOpenChange={setNewOpen} pipelines={pipelineList} defaultPipelineId={pipelineId} />
    </div>
  );
}

function ViewButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-sm font-medium transition-colors [&_svg]:size-4",
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

  const hasFilters = Boolean(params.q || params.owner || params.status);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input aria-label="Search deals" placeholder="Search deals…" value={draft} onChange={(e) => setDraft(e.target.value)} className="pl-8" maxLength={200} />
      </div>
      <Select value={params.owner === "me" ? "me" : "all"} onValueChange={(v) => setParam("owner", v === "me" ? "me" : undefined)}>
        <SelectTrigger className="w-36" aria-label="Owner filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Everyone&apos;s</SelectItem>
          <SelectItem value="me">Mine</SelectItem>
        </SelectContent>
      </Select>
      <Select value={params.status ?? ALL} onValueChange={(v) => setParam("status", v === ALL ? undefined : v)}>
        <SelectTrigger className="w-36" aria-label="Status filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any status</SelectItem>
          <SelectItem value="open">Open</SelectItem>
          <SelectItem value="won">Won</SelectItem>
          <SelectItem value="lost">Lost</SelectItem>
        </SelectContent>
      </Select>
      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
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
        <Skeleton key={i} className="h-72 w-72 shrink-0" />
      ))}
    </div>
  );
}
