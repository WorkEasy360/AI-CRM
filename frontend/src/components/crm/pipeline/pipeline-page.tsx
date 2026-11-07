"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, CalendarRange, CornerDownRight, Filter, IndianRupee, KanbanSquare, LayoutGrid, LineChart, List, Lock, Plus, Search, Settings2, Target, Trophy, X } from "lucide-react";
import { DealsList } from "@/components/crm/pipeline/deals-list";
import { DealDetailsPanel } from "@/components/crm/pipeline/deal-details-panel";
import { KanbanBoard, type BoardSort } from "@/components/crm/pipeline/kanban-board";
import { PipelineAnalyticsView } from "@/components/crm/pipeline/pipeline-analytics";
import { KpiTile, percentChange, pointChange, type KpiChange } from "@/components/dashboard/stat-tile";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import dynamic from "next/dynamic";
import { getBoard, getCompany, getContact, listPipelines, listProducts } from "@/lib/api/crm";
import { DEAL_SOURCES, DEAL_SOURCE_LABELS, type ListParams, type Pipeline } from "@/lib/api/crm-types";
import { listMembers } from "@/lib/api/endpoints";
import { getPipelineStats, pipelineKeys } from "@/lib/api/pipeline-analytics";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useWarmRecordForm } from "@/lib/crm/use-custom-fields";
import { useDebounced, useListParams } from "@/lib/crm/use-list-params";
import { queryKeys, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn } from "@/lib/utils";
import { orderFamilies } from "@/lib/crm/pipelines";
import { VIEW_KEYS, columnsOf, filterParams, viewKindOf } from "@/lib/views";
import { ViewBar } from "@/components/views/view-bar";

const SheetView = dynamic(() => import("@/components/views/sheet-view").then((m) => m.SheetView), { ssr: false });
const RecordCalendar = dynamic(() => import("@/components/views/record-calendar").then((m) => m.RecordCalendar), { ssr: false });
const RecordChart = dynamic(() => import("@/components/views/record-chart").then((m) => m.RecordChart), { ssr: false });
const ForecastPage = dynamic(() => import("@/components/forecast/forecast-page").then((m) => m.ForecastPage), { ssr: false });

// The new-deal form is a click away, not part of the board: it is imported lazily and mounted only
// while it is open. `useWarmRecordForm` loads it, and the deal custom fields it renders, ahead of the
// click; leaving it mounted with `open={false}` downloaded both on every visit to the board.
const importDealForm = () => import("@/components/crm/deals/deal-form-dialog");
const DealFormDialog = dynamic(() => importDealForm().then((m) => m.DealFormDialog), { ssr: false });

const ALL = "__all__";
const URL_KEYS = ["pipeline", "new", "company", "contact", "q", "owner", "status", "stage", "sort", "archived", "tab", "lead_source", "product", "deal", "into", ...VIEW_KEYS] as const;
/** Cards per column on the first board load; the rest page in as a column is scrolled. */
const BOARD_PER_STAGE = 200;
const BOARD_KEYS = ["q", "owner", "status", "lead_source", "product"] as const;
/** Filters that also narrow the KPI row and Analytics (not status: a won/lost filter would empty the win rate). */
const STATS_KEYS = ["q", "owner", "lead_source", "product"] as const;
type PageTab = "kanban" | "list" | "forecast" | "analytics";

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
  const kind = viewKindOf(params.view, "kanban");
  const view = kind === "kanban" ? "board" : kind;
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
    queryFn: () => getBoard(params.pipeline, boardParams, BOARD_PER_STAGE),
    enabled: view === "board",
    placeholderData: (prev) => prev,
  });

  const statsParams = React.useMemo<ListParams>(() => {
    const out: ListParams = {};
    for (const key of STATS_KEYS) if (params[key]) out[key] = params[key];
    return out;
  }, [params]);
  const stats = useQuery({
    queryKey: pipelineKeys.stats(params.pipeline, statsParams),
    queryFn: () => getPipelineStats(params.pipeline, statsParams),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
  const pageTab: PageTab = params.tab === "forecast" || params.tab === "analytics" ? params.tab : view === "list" ? "list" : "kanban";
  const stageTargets = React.useMemo(() => (board.data?.stages ?? []).map((s) => ({ id: s.id, name: s.name, kind: s.kind })), [board.data]);

  const summary = React.useMemo(() => {
    if (!board.data) return null;
    let open = 0;
    let total = 0;
    for (const stage of board.data.stages) {
      total += stage.deal_count;
      if (stage.kind === "open") open += stage.deal_count;
    }
    // Totals come from the server: computed over every deal in scope, hidden with the amount field.
    const totals = board.data.totals;
    return { open, total, openAmount: totals?.open_amount_base ?? null, weighted: totals?.weighted_forecast_base ?? null };
  }, [board.data]);
  // Filters for the generic views: the board/list filters plus the selected pipeline (a deal filter).
  const viewFilters = React.useMemo<ListParams>(
    () => ({ ...filterParams(params, ["pipeline"]), ...(pipelineId ? { pipeline: pipelineId } : {}), company: undefined, contact: undefined }),
    [params, pipelineId],
  );

  const warmForm = useWarmRecordForm("deal", importDealForm);
  const setNewOpen = (open: boolean) => (open ? setParam("new", "1") : setParams({ new: undefined, company: undefined, contact: undefined, into: undefined }));
  const selectTab = (tab: PageTab) =>
    setParams(tab === "forecast" || tab === "analytics" ? { tab } : { tab: undefined, view: tab === "list" ? "list" : undefined });
  const selectPipeline = (id: string) => setParams({ pipeline: id, stage: undefined });
  const listFilterCount = Object.keys(params).filter((k) => ["status", "stage", "archived", "owner"].includes(k) || k.startsWith("custom.")).length;
  const showPanel = pipelineList.length > 1 || canManagePipelines;

  return (
    <div className="flex h-full min-h-0 gap-4">
      {showPanel && pipelines.isSuccess ? (
        <PipelinePanel pipelines={pipelineList} selectedId={pipelineId} onSelect={selectPipeline} canManage={canManagePipelines} />
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PageHeader icon={Filter} title="Pipeline – Leads & Deals" className="mb-3" />
        <PipelineKpis stats={stats.data} baseCurrency={baseCurrency} />
        {summary ? (
          <p className="sr-only" aria-live="polite">
            {summary.open} open {summary.open === 1 ? "deal" : "deals"}
            {summary.openAmount !== null ? ` · ${formatMoney(summary.openAmount, baseCurrency)}` : ""}
          </p>
        ) : null}

        <div className="mb-3 mt-4 flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Pipeline views" className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-surface p-1 shadow-sm">
            {(
              [
                ["kanban", "Kanban View", LayoutGrid],
                ["list", "List View", List],
                ["forecast", "Forecast", LineChart],
                ["analytics", "Analytics", BarChart3],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={pageTab === value}
                onClick={() => selectTab(value)}
                className={cn("inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors", pageTab === value ? "bg-brand text-brand-fg shadow-sm" : "text-fg hover:bg-bg-subtle")}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>
          {canCreate ? (
            <Button className="ml-auto" onClick={() => setNewOpen(true)} onPointerEnter={warmForm} onFocus={warmForm} disabled={pipelineList.length === 0}>
              <Plus /> Add Deal
            </Button>
          ) : null}
        </div>

        {pageTab === "kanban" || pageTab === "list" ? (
          <ViewBar entity="deal" kind={kind} defaultKind="kanban" params={params} setParams={setParams} ownedKeys={["pipeline"]} extraFilterKeys={["pipeline"]} />
        ) : null}
        {board.data?.family && board.data.family.length > 1 && view === "board" ? (
          <div className="mb-2 flex flex-wrap items-center gap-1" role="group" aria-label="Sub-pipelines">
            {board.data.family.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => selectPipeline(f.id)}
                aria-pressed={f.id === board.data?.pipeline?.id}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium",
                  f.id === board.data?.pipeline?.id ? "border-primary bg-primary-soft text-primary" : "border-border text-fg-muted hover:text-fg",
                )}
              >
                {f.parent_id ? <CornerDownRight className="size-3" aria-hidden /> : null}
                {f.name}
              </button>
            ))}
          </div>
        ) : null}
        {pageTab === "forecast" ? (
          <ForecastPage embedded />
        ) : pageTab === "analytics" ? (
          <>
            <BoardFilters params={params} setParam={setParam} onClear={() => setParams({ q: undefined, owner: undefined, lead_source: undefined, product: undefined })} pipelineSelect={<PipelineSelect pipelines={pipelineList} selected={selectedPipeline} onSelect={selectPipeline} />} hideStatus />
            <PipelineAnalyticsView pipelineId={pipelineId} filters={statsParams} baseCurrency={baseCurrency} />
          </>
        ) : pipelines.isError ? (
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
        ) : view === "sheet" || view === "calendar" || view === "chart" ? (
          pipelines.isPending ? (
            <SkeletonRows rows={6} />
          ) : view === "sheet" ? (
            <SheetView entity="deal" filters={viewFilters} columns={columnsOf(params)} onColumnsChange={(cols) => setParam("cols", cols.join(",") || undefined)} />
          ) : view === "calendar" ? (
            <RecordCalendar
              entity="deal"
              filters={viewFilters}
              dateField={params.datef ?? "expected_close_date"}
              onDateFieldChange={(f) => setParam("datef", f)}
              includeActivities={params.acts !== "0"}
              onIncludeActivitiesChange={(on) => setParam("acts", on ? undefined : "0")}
            />
          ) : (
            <RecordChart
              entity="deal"
              filters={viewFilters}
              groupBy={params.group ?? "stage"}
              measure={params.measure === "count" ? "count" : "sum"}
              field={params.mfield ?? "amount"}
              baseCurrency={baseCurrency}
              onChange={(patch) => setParams(patch)}
            />
          )
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
            <BoardFilters
              params={params}
              setParam={setParam}
              onClear={() => setParams({ q: undefined, owner: undefined, status: undefined, sort: undefined, lead_source: undefined, product: undefined })}
              pipelineSelect={<PipelineSelect pipelines={pipelineList} selected={selectedPipeline} onSelect={selectPipeline} />}
            />
            {board.isPending || pipelines.isPending ? (
              <BoardSkeleton />
            ) : board.isError ? (
              <EmptyState title="Could not load the board" description={errorMessage(board.error)} action={<Button variant="secondary" onClick={() => board.refetch()}>Retry</Button>} />
            ) : (
              <KanbanBoard
                board={board.data}
                baseCurrency={baseCurrency}
                canMove={canMove}
                showRisk={showRisk}
                isFetching={board.isFetching}
                sort={boardSortOf(params.sort)}
                filters={boardParams}
                onOpenDeal={(deal) => setParam("deal", deal.id)}
                onAddDeal={canCreate ? (stage) => setParams({ new: "1", into: stage.id }) : undefined}
              />
            )}
          </>
        )}
      </div>

      {newOpen && canCreate ? (
        <DealFormDialog open onOpenChange={setNewOpen} pipelines={pipelineList} defaultPipelineId={pipelineId} defaultStageId={params.into} defaults={formDefaults} />
      ) : null}
      <DealDetailsPanel dealId={params.deal ?? null} stages={stageTargets} onClose={() => setParam("deal", undefined)} />
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
    // A light column beside the sidebar; the negative margins cancel <main>'s padding (xl only).
    <aside className="-my-4 -ml-5 hidden w-48 shrink-0 overflow-y-auto border-r border-border bg-surface px-2 py-4 xl:block" aria-label="Pipelines">
      <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Pipelines</p>
      <ul className="flex flex-col gap-0.5">
        {orderFamilies(pipelines).map((p) => {
          const current = p.id === selectedId;
          return (
            <li key={p.id} className={p.parent_id ? "pl-3" : undefined}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm font-medium transition-colors",
                  current ? "bg-primary-soft text-primary" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                )}
              >
                {p.parent_id ? <CornerDownRight className="size-3.5 shrink-0" aria-hidden /> : <KanbanSquare className="size-4 shrink-0" aria-hidden />}
                <span className="truncate">{p.name}</span>
                {p.restricted ? <Lock className="ml-auto size-3 shrink-0 text-fg-subtle" aria-label="Restricted" /> : null}
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


function PipelineSelect({ pipelines, selected, onSelect }: { pipelines: Pipeline[]; selected: Pipeline | null; onSelect: (id: string) => void }) {
  if (pipelines.length === 0) return null;
  return (
    <Select value={selected?.id ?? ""} onValueChange={onSelect}>
      <SelectTrigger className="h-9 w-48" aria-label="Pipeline">
        <SelectValue placeholder="Pipeline" />
      </SelectTrigger>
      <SelectContent>
        {orderFamilies(pipelines).map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The Pipeline KPI row: totals over the board's deal set, compared with the previous 30 days. */
function PipelineKpis({ stats, baseCurrency }: { stats: import("@/lib/api/pipeline-analytics").PipelineStats | undefined; baseCurrency: string }) {
  const versus = stats ? `vs previous ${stats.days} days` : "";
  const money = (v: string | null | undefined) => (v === null ? "—" : v === undefined ? undefined : formatMoney(v, baseCurrency));
  const cycle: KpiChange | null = stats ? withLowerIsBetter(percentChange(stats.current.avg_cycle_days, stats.previous.avg_cycle_days, versus)) : null;
  return (
    <section aria-label="Pipeline summary" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      <KpiTile tone="green" icon={<BarChart3 />} label="Total Deals" value={stats?.total_deals.toLocaleString()} change={stats ? percentChange(stats.current.created, stats.previous.created, versus) : null} changeNote="new" />
      <KpiTile tone="blue" icon={<IndianRupee />} label="Pipeline Value" value={money(stats?.pipeline_value)} sub={stats ? `${stats.open_deals.toLocaleString()} open deals` : undefined} />
      <KpiTile tone="orange" icon={<Trophy />} label="Expected Revenue" value={money(stats?.expected_revenue)} sub="Weighted by probability" />
      <KpiTile tone="purple" icon={<Target />} label="Win Rate" value={stats ? (stats.current.win_rate === null ? "—" : `${Math.round(stats.current.win_rate)}%`) : undefined} change={stats ? pointChange(stats.current.win_rate, stats.previous.win_rate, versus) : null} changeNote="" sub={stats?.current.win_rate === null ? "No deals closed in 30 days" : "Deals closed in 30 days"} />
      <KpiTile tone="pink" icon={<CalendarRange />} label="Avg. Deal Cycle" value={stats ? (stats.current.avg_cycle_days === null ? "—" : `${Math.round(stats.current.avg_cycle_days)} Days`) : undefined} change={cycle} changeNote="" sub={stats?.current.avg_cycle_days === null ? "No deals won in 30 days" : "Created to won"} />
    </section>
  );
}

function withLowerIsBetter(change: KpiChange | null): KpiChange | null {
  return change ? { ...change, lowerIsBetter: true } : null;
}

function OwnerFilter({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const members = useCursorList(queryKeys.members, listMembers);
  const options = members.isError ? [] : members.items.filter((m) => m.status === "active");
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className="h-9 w-36" aria-label="Owner filter">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All Owners</SelectItem>
        <SelectItem value="me">My deals</SelectItem>
        {options.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.user.display_name || m.user.email}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ProductFilter({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const { data: session } = useSession();
  const allowed = can(session?.active ?? null, "products.view");
  const products = useQuery({ queryKey: ["crm", "products", "filter-options"], queryFn: () => listProducts({ limit: "100", sort: "name" }), enabled: allowed, staleTime: 60_000 });
  if (!allowed || products.isError) return null;
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className="h-9 w-40" aria-label="Product filter">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All Products</SelectItem>
        {(products.data?.results ?? []).map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function BoardFilters({
  params,
  setParam,
  onClear,
  pipelineSelect,
  hideStatus = false,
}: {
  params: ListParams;
  setParam: (key: string, value: string | undefined) => void;
  onClear: () => void;
  pipelineSelect?: React.ReactNode;
  hideStatus?: boolean;
}) {
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

  const hasFilters = Boolean(params.q || params.owner || params.status || params.sort || params.lead_source || params.product);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-60">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input aria-label="Search deals" placeholder="Search deals…" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-9 pl-8" maxLength={200} />
      </div>
      {pipelineSelect}
      <OwnerFilter value={params.owner} onChange={(v) => setParam("owner", v)} />
      <Select value={params.lead_source ?? ALL} onValueChange={(v) => setParam("lead_source", v === ALL ? undefined : v)}>
        <SelectTrigger className="h-9 w-36" aria-label="Source filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All Sources</SelectItem>
          {DEAL_SOURCES.map((source) => (
            <SelectItem key={source} value={source}>
              {DEAL_SOURCE_LABELS[source]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ProductFilter value={params.product} onChange={(v) => setParam("product", v)} />
      {hideStatus ? null : (
        <Select value={params.status ?? ALL} onValueChange={(v) => setParam("status", v === ALL ? undefined : v)}>
          <SelectTrigger className="h-9 w-32" aria-label="Status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="won">Won</SelectItem>
            <SelectItem value="lost">Lost</SelectItem>
          </SelectContent>
        </Select>
      )}
      <Select value={boardSortOf(params.sort)} onValueChange={(v) => setParam("sort", v === "recent" ? undefined : v)}>
        <SelectTrigger className="h-9 w-40" aria-label="Sort">
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
