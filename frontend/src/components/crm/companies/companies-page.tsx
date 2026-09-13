"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, Building2, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BulkBar } from "@/components/crm/bulk-bar";
import { CompanyFormDialog } from "@/components/crm/companies/company-form-dialog";
import { Dash, LastActivityCell, NextActivityCell } from "@/components/crm/contacts/activity-cells";
import { DataTable, useSelection, type Column } from "@/components/crm/data-table";
import { LifecycleBadge } from "@/components/crm/lifecycle-badge";
import { LifecycleSelect } from "@/components/crm/lifecycle-select";
import { ListToolbar, type SortOption } from "@/components/crm/list-toolbar";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listCompanies } from "@/lib/api/crm";
import { COMPANY_SIZES, type Company, type LifecycleStage, type ListParams } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useDebounced, useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";

const ALLOWED = ["q", "sort", "owner", "archived", "industry", "company_size", "lifecycle", "source", "created_from", "created_to"] as const;
const DEFAULTS: ListParams = { sort: "-created_at" };
const SORT_OPTIONS: SortOption[] = [
  { value: "-created_at", label: "Newest first" },
  { value: "created_at", label: "Oldest first" },
  { value: "-updated_at", label: "Recently updated" },
  { value: "name", label: "Name A–Z" },
  { value: "-name", label: "Name Z–A" },
  { value: "industry", label: "Industry A–Z" },
  { value: "lifecycle", label: "Status" },
  { value: "-last_activity_at", label: "Recent activity" },
  { value: "next_activity_at", label: "Next activity soonest" },
];

const enc = encodeURIComponent;

function IndustryFilter({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  const [draft, setDraft] = React.useState(value ?? "");
  const debounced = useDebounced(draft, 300);
  React.useEffect(() => {
    if ((value ?? "") !== debounced) onChange(debounced || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  React.useEffect(() => {
    if (value === undefined && draft !== "") setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <Input aria-label="Industry filter" placeholder="Industry" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 w-full sm:w-40" maxLength={80} />;
}

export function CompaniesPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const currency = active?.organization.base_currency ?? "USD";
  const canCreate = can(active, "companies.create");
  const canDelete = can(active, "companies.delete");
  const canBulk = can(active, "companies.bulk_update");

  const { params, setParam, setParams, clear, activeFilterCount } = useListParams(ALLOWED, DEFAULTS);
  const searchParams = useSearchParams();
  const wantsNew = canCreate && searchParams?.get("new") === "1";
  const archivedView = params.archived === "true";

  const list = useCursorList<Company>(crmKeys.list("companies", params), (cursor) => listCompanies(params, cursor), true, {
    recordKey: (row) => crmKeys.record("companies", row.id),
  });
  const selection = useSelection();
  const { archive, restore } = useArchiveRestore("company");

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Company | null>(null);

  const closeDialog = () => {
    setCreateOpen(false);
    setEditing(null);
    if (wantsNew) setParam("new", undefined);
  };

  const { clear: clearSelection } = selection;
  React.useEffect(() => {
    clearSelection();
  }, [params, clearSelection]);

  const columns = React.useMemo<Column<Company>[]>(
    () => [
      {
        key: "name",
        header: "Name",
        sortKey: "name",
        className: "min-w-40",
        render: (c) => (
          <span className="inline-flex items-center gap-2">
            {c.name}
            {c.archived_at ? <Badge variant="warning">Archived</Badge> : null}
          </span>
        ),
      },
      { key: "industry", header: "Industry", sortKey: "industry", className: "hidden md:table-cell max-w-40", render: (c) => (c.industry ? <span className="block truncate">{c.industry}</span> : <Dash />) },
      { key: "lifecycle", header: "Status", sortKey: "lifecycle", render: (c) => <LifecycleBadge stage={c.lifecycle_stage} /> },
      { key: "contacts", header: "Contacts", className: "hidden sm:table-cell text-right tabular-nums", render: (c) => c.contact_count.toLocaleString() },
      {
        key: "open_deals",
        header: "Open deals",
        className: "text-right tabular-nums whitespace-nowrap",
        render: (c) =>
          c.open_deal_count > 0 ? (
            <span className="flex flex-col leading-tight">
              <span>{c.open_deal_count.toLocaleString()}</span>
              <span className="text-xs text-fg-subtle">{formatMoney(c.open_deal_amount, currency)}</span>
            </span>
          ) : (
            <Dash />
          ),
      },
      { key: "owner", header: "Owner", className: "hidden xl:table-cell", render: (c) => c.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span> },
      {
        key: "last_activity",
        header: "Last activity",
        sortKey: "last_activity_at",
        className: "hidden md:table-cell whitespace-nowrap",
        render: (c) => <LastActivityCell value={c.last_activity_at} />,
      },
      {
        key: "next_activity",
        header: "Next activity",
        sortKey: "next_activity_at",
        className: "hidden lg:table-cell max-w-48",
        render: (c) => <NextActivityCell at={c.next_activity_at} title={c.next_activity_title} />,
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        className: "w-10 text-right",
        render: (c) => {
          const editable = canEditRecord(active, "companies", c.owner?.id);
          if (!editable && !canDelete) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {editable ? (
                  <DropdownMenuItem onSelect={() => setEditing(c)}>
                    <Pencil /> Edit
                  </DropdownMenuItem>
                ) : null}
                {canDelete && c.archived_at ? (
                  <DropdownMenuItem onSelect={() => restore.mutate(c.id)}>
                    <ArchiveRestore /> Restore
                  </DropdownMenuItem>
                ) : null}
                {canDelete && !c.archived_at ? (
                  <DropdownMenuItem destructive onSelect={() => archive.mutate(c.id)}>
                    <Archive /> Archive
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [active, currency, canDelete, archive, restore],
  );

  const filtered = Boolean(params.q) || activeFilterCount > 0;
  const empty = filtered ? (
    <EmptyState
      title="No companies match"
      description="Try different keywords or clear the filters."
      action={
        <Button variant="secondary" onClick={clear}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={<Building2 />}
      title="No companies yet"
      description="Add the accounts you sell to. Their contacts and deals gather underneath."
      action={
        canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> Company
          </Button>
        ) : null
      }
    />
  );

  return (
    <div>
      <PageHeader title="Companies" />

      <ListToolbar
        params={params}
        setParam={setParam}
        setParams={setParams}
        clear={clear}
        sortOptions={SORT_OPTIONS}
        activeFilterCount={activeFilterCount}
        entityLabel="companies"
        searchPlaceholder="Search companies…"
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> Company
            </Button>
          ) : null
        }
      >
        <LifecycleSelect
          allowAll
          value={(params.lifecycle as LifecycleStage | undefined) ?? ""}
          onChange={(v) => setParam("lifecycle", v || undefined)}
          className="h-8 w-40"
          ariaLabel="Status filter"
        />
        <IndustryFilter value={params.industry} onChange={(v) => setParam("industry", v)} />
        <Select value={params.company_size ?? "all"} onValueChange={(v) => setParam("company_size", v === "all" ? undefined : v)}>
          <SelectTrigger className="h-8 w-40" aria-label="Company size filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any size</SelectItem>
            {COMPANY_SIZES.map((s) => (
              <SelectItem key={s} value={s}>
                {s} employees
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ListToolbar>

      {canBulk ? <BulkBar entity="company" selected={selection.selected} onClear={selection.clear} archivedView={archivedView} /> : null}

      <DataTable
        rows={list.items}
        columns={columns}
        sort={params.sort}
        onSort={(s) => setParam("sort", s)}
        rowHref={(c) => `/companies/${enc(c.id)}`}
        selectable={canBulk}
        selected={selection.selected}
        onToggle={selection.toggle}
        onToggleAll={selection.toggleAll}
        isPending={list.isPending}
        isRefreshing={list.isPlaceholderData}
        isError={list.isError}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={empty}
        hasMore={list.hasMore}
        onLoadMore={() => list.loadMore()}
        isLoadingMore={list.isLoadingMore}
        caption="Companies"
      />

      <CompanyFormDialog open={createOpen || wantsNew || editing !== null} company={editing} onOpenChange={(open) => !open && closeDialog()} />
    </div>
  );
}
