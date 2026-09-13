"use client";

import * as React from "react";
import Link from "next/link";
import { Handshake } from "lucide-react";
import { DataTable, type Column } from "@/components/crm/data-table";
import { ListToolbar, type SortOption } from "@/components/crm/list-toolbar";
import { TagList } from "@/components/crm/tag-picker";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listDeals } from "@/lib/api/crm";
import type { Deal, DealStatus, ListParams, Pipeline } from "@/lib/api/crm-types";
import { colorClasses, formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn, formatDate, formatDateTime } from "@/lib/utils";

const ALL = "__all__";

const SORT_OPTIONS: SortOption[] = [
  { value: "-updated_at", label: "Recently updated" },
  { value: "-created_at", label: "Newest" },
  { value: "name", label: "Name A–Z" },
  { value: "-amount", label: "Amount high–low" },
  { value: "amount", label: "Amount low–high" },
  { value: "expected_close_date", label: "Closing soonest" },
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
  clear,
  activeFilterCount,
  pipeline,
  onNewDeal,
  canCreate,
}: {
  params: ListParams;
  setParam: (key: string, value: string | undefined) => void;
  clear: () => void;
  activeFilterCount: number;
  pipeline: Pipeline | null;
  onNewDeal: () => void;
  canCreate: boolean;
}) {
  const apiParams = React.useMemo<ListParams>(() => {
    const { view: _view, new: _new, ...rest } = params;
    return { sort: "-updated_at", ...rest };
  }, [params]);

  const list = useCursorList<Deal>(crmKeys.list("deals", apiParams), (cursor) => listDeals(apiParams, cursor));

  const columns = React.useMemo<Column<Deal>[]>(
    () => [
      { key: "name", header: "Name", sortKey: "name", render: (d) => d.name, className: "min-w-48" },
      { key: "stage", header: "Stage", render: (d) => <StageBadge name={d.stage.name} colorToken={d.stage.color_token} /> },
      {
        key: "company",
        header: "Company",
        render: (d) =>
          d.company ? (
            <Link href={`/companies/${encodeURIComponent(d.company.id)}`} className="hover:text-primary hover:underline">
              {d.company.name}
            </Link>
          ) : (
            <span className="text-fg-subtle">—</span>
          ),
      },
      {
        key: "contact",
        header: "Contact",
        render: (d) =>
          d.primary_contact ? (
            <Link href={`/contacts/${encodeURIComponent(d.primary_contact.id)}`} className="hover:text-primary hover:underline">
              {d.primary_contact.name}
            </Link>
          ) : (
            <span className="text-fg-subtle">—</span>
          ),
      },
      { key: "amount", header: "Amount", sortKey: "amount", className: "text-right", render: (d) => <span className="tabular-nums">{formatMoney(d.amount, d.currency)}</span> },
      { key: "probability", header: "Probability", className: "text-right", render: (d) => <span className="tabular-nums">{d.probability}%</span> },
      { key: "close", header: "Expected close", sortKey: "expected_close_date", render: (d) => formatDate(d.expected_close_date) },
      {
        key: "owner",
        header: "Owner",
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
      { key: "tags", header: "Tags", render: (d) => <TagList tags={d.tags} max={2} /> },
      { key: "updated", header: "Updated", sortKey: "updated_at", render: (d) => <span className="whitespace-nowrap text-fg-muted">{formatDateTime(d.updated_at)}</span> },
    ],
    [],
  );

  const stages = pipeline?.stages ?? [];

  return (
    <div>
      <ListToolbar params={params} setParam={setParam} clear={clear} sortOptions={SORT_OPTIONS} activeFilterCount={activeFilterCount} searchPlaceholder="Search deals…">
        <Select value={params.status ?? ALL} onValueChange={(v) => setParam("status", v === ALL ? undefined : v)}>
          <SelectTrigger className="w-32" aria-label="Status filter">
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
            <SelectTrigger className="w-40" aria-label="Stage filter">
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
