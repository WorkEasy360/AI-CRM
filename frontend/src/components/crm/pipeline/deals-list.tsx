"use client";

import * as React from "react";
import Link from "next/link";
import { Handshake } from "lucide-react";
import { DataTable, type Column } from "@/components/crm/data-table";
import { isPastClose, relativeDayLabel } from "@/components/crm/deals/deal-helpers";
import { ListToolbar, type SortOption } from "@/components/crm/list-toolbar";
import { RiskBadge } from "@/components/crm/risk-badge";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listDeals } from "@/lib/api/crm";
import type { Deal, DealStatus, ListParams, Pipeline } from "@/lib/api/crm-types";
import { colorClasses, formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn, formatDate } from "@/lib/utils";

const ALL = "__all__";

const SORT_OPTIONS: SortOption[] = [
  { value: "-updated_at", label: "Recently updated" },
  { value: "-created_at", label: "Newest" },
  { value: "name", label: "Name A–Z" },
  { value: "-amount", label: "Amount high–low" },
  { value: "amount", label: "Amount low–high" },
  { value: "-probability", label: "Probability high–low" },
  { value: "probability", label: "Probability low–high" },
  { value: "expected_close_date", label: "Closing soonest" },
  { value: "next_activity_at", label: "Next activity soonest" },
  { value: "-last_activity_at", label: "Recently active" },
  { value: "last_activity_at", label: "Longest untouched" },
  { value: "-stage_entered_at", label: "Recently moved" },
];

export function StatusBadge({ status }: { status: DealStatus }) {
  if (status === "won") return <Badge variant="success">Won</Badge>;
  if (status === "lost") return <Badge variant="danger">Lost</Badge>;
  return <Badge variant="primary">Open</Badge>;
}

export function StageBadge({ name, colorToken, className }: { name: string; colorToken: string; className?: string }) {
  return <span className={cn("inline-flex max-w-48 items-center truncate rounded-full px-2 py-0.5 text-xs font-medium", colorClasses(colorToken), className)}>{name}</span>;
}

/** Deals as a sortable table; filters live in the URL alongside the board's. */
export function DealsList({
  params,
  setParam,
  setParams,
  clear,
  activeFilterCount,
  pipeline,
  onNewDeal,
  canCreate,
}: {
  params: ListParams;
  setParam: (key: string, value: string | undefined) => void;
  setParams: (patch: ListParams) => void;
  clear: () => void;
  activeFilterCount: number;
  pipeline: Pipeline | null;
  onNewDeal: () => void;
  canCreate: boolean;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const baseCurrency = active?.organization.base_currency ?? "USD";
  const showRisk = can(active, "ai.scores.view");

  const apiParams = React.useMemo<ListParams>(() => {
    const { view: _view, new: _new, company: _company, contact: _contact, ...rest } = params;
    const sort = SORT_OPTIONS.some((o) => o.value === rest.sort) ? rest.sort : "-updated_at";
    return { ...rest, sort };
  }, [params]);

  const list = useCursorList<Deal>(crmKeys.list("deals", apiParams), (cursor) => listDeals(apiParams, cursor), true, {
    recordKey: (row) => crmKeys.record("deals", row.id),
  });

  const columns = React.useMemo<Column<Deal>[]>(
    () => [
      { key: "name", header: "Deal name", sortKey: "name", render: (d) => d.name, className: "min-w-44" },
      { key: "stage", header: "Stage", render: (d) => <StageBadge name={d.stage.name} colorToken={d.stage.color_token} /> },
      {
        key: "company",
        header: "Company",
        className: "hidden lg:table-cell",
        render: (d) =>
          d.company ? (
            <Link href={`/companies/${encodeURIComponent(d.company.id)}`} className="hover:text-primary hover:underline">
              {d.company.name}
            </Link>
          ) : d.primary_contact ? (
            <Link href={`/contacts/${encodeURIComponent(d.primary_contact.id)}`} className="hover:text-primary hover:underline">
              {d.primary_contact.name}
            </Link>
          ) : (
            <span className="text-fg-subtle">—</span>
          ),
      },
      { key: "amount", header: "Amount", sortKey: "amount", className: "text-right whitespace-nowrap", render: (d) => <span className="tabular-nums">{formatMoney(d.amount, d.currency)}</span> },
      {
        key: "probability",
        header: "Probability",
        sortKey: "probability",
        className: "text-right whitespace-nowrap",
        render: (d) => (
          <span className="tabular-nums" title={d.probability_overridden ? "Set by hand" : "Stage default"}>
            {d.probability}%{d.probability_overridden ? <span className="ml-1 text-[10px] uppercase text-fg-subtle">manual</span> : null}
          </span>
        ),
      },
      {
        key: "weighted",
        header: "Weighted",
        className: "hidden text-right whitespace-nowrap md:table-cell",
        render: (d) => <span className="tabular-nums text-fg-muted">{formatMoney(d.weighted_amount_base, baseCurrency)}</span>,
      },
      {
        key: "close",
        header: "Expected close",
        sortKey: "expected_close_date",
        className: "whitespace-nowrap",
        render: (d) => <span className={isPastClose(d) ? "text-danger" : undefined}>{formatDate(d.expected_close_date)}</span>,
      },
      {
        key: "next",
        header: "Next activity",
        sortKey: "next_activity_at",
        className: "hidden max-w-48 md:table-cell",
        render: (d) =>
          d.next_activity_at ? (
            <span className="block truncate" title={d.next_activity_title || undefined}>
              <span className="text-fg-muted">{relativeDayLabel(d.next_activity_at)}</span>
              {d.next_activity_title ? ` · ${d.next_activity_title}` : ""}
            </span>
          ) : d.status === "open" ? (
            <span className="text-danger/80">No next step</span>
          ) : (
            <span className="text-fg-subtle">—</span>
          ),
      },
      ...(showRisk
        ? [
            {
              key: "risk",
              header: "Risk",
              className: "whitespace-nowrap",
              render: (d: Deal) => (d.status === "open" ? <RiskBadge level={d.risk_level} /> : <span className="text-fg-subtle">—</span>),
            },
          ]
        : []),
      {
        key: "owner",
        header: "Owner",
        className: "hidden xl:table-cell",
        render: (d) =>
          d.owner ? (
            <span className="inline-flex items-center gap-2">
              <Avatar name={d.owner.display_name} size="sm" />
              <span className="truncate">{d.owner.display_name}</span>
            </span>
          ) : (
            <span className="text-fg-subtle">Unassigned</span>
          ),
      },
      { key: "status", header: "Status", render: (d) => <StatusBadge status={d.status} /> },
    ],
    [baseCurrency, showRisk],
  );

  const stages = pipeline?.stages ?? [];

  return (
    <div>
      <ListToolbar
        params={apiParams}
        setParam={setParam}
        setParams={setParams}
        clear={clear}
        sortOptions={SORT_OPTIONS}
        activeFilterCount={activeFilterCount}
        entityLabel="deals"
        searchPlaceholder="Search deals…"
      >
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
        {stages.length > 0 ? (
          <Select value={params.stage ?? ALL} onValueChange={(v) => setParam("stage", v === ALL ? undefined : v)}>
            <SelectTrigger className="h-8 w-40" aria-label="Stage filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any stage</SelectItem>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </ListToolbar>
      <DataTable
        rows={list.items}
        columns={columns}
        sort={apiParams.sort}
        onSort={(sort) => setParam("sort", sort)}
        rowHref={(d) => `/deals/${encodeURIComponent(d.id)}`}
        isPending={list.isPending}
        isRefreshing={list.isPlaceholderData}
        isError={list.isError}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={() => list.loadMore()}
        isLoadingMore={list.isLoadingMore}
        caption="Deals"
        empty={
          <EmptyState
            icon={<Handshake />}
            title={params.q || activeFilterCount > 0 ? "No deals match these filters" : "No deals yet"}
            description={params.q || activeFilterCount > 0 ? "Try widening the search or clearing filters." : "Create a deal to start tracking it through the pipeline."}
            action={
              params.q || activeFilterCount > 0 ? (
                <Button variant="secondary" onClick={clear}>
                  Clear filters
                </Button>
              ) : canCreate ? (
                <Button onClick={onNewDeal}>New deal</Button>
              ) : null
            }
          />
        }
      />
    </div>
  );
}
