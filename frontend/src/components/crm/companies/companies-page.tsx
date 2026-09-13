"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Building2, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BulkBar } from "@/components/crm/bulk-bar";
import { CompanyFormDialog } from "@/components/crm/companies/company-form-dialog";
import { DataTable, useSelection, type Column } from "@/components/crm/data-table";
import { ListToolbar, type SortOption } from "@/components/crm/list-toolbar";
import { TagList } from "@/components/crm/tag-picker";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { companyStats, listCompanies } from "@/lib/api/crm";
import { COMPANY_SIZES, type Company, type CompanyStats, type ListParams } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useDebounced, useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";

const ALLOWED = ["q", "sort", "owner", "archived", "industry", "company_size", "source", "created_from", "created_to"] as const;
const DEFAULTS: ListParams = { sort: "-created_at" };
const SORT_OPTIONS: SortOption[] = [
  { value: "-created_at", label: "Newest first" },
  { value: "created_at", label: "Oldest first" },
  { value: "-updated_at", label: "Recently updated" },
  { value: "name", label: "Name A–Z" },
  { value: "-name", label: "Name Z–A" },
  { value: "industry", label: "Industry A–Z" },
];

const enc = encodeURIComponent;

function Dash() {
  return <span className="text-fg-subtle">—</span>;
}

/** Display a website as a short host name, as text only (no outbound link for untrusted input). */
function websiteLabel(website: string): string {
  try {
    const url = new URL(website.includes("://") ? website : `https://${website}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return website;
  }
}

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
  return <Input aria-label="Industry filter" placeholder="Industry" value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full sm:w-40" maxLength={80} />;
}

function Kpis({ stats }: { stats: CompanyStats | undefined }) {
  const items = [
    { label: "Total companies", value: stats?.total },
    { label: "With open deals", value: stats?.with_open_deals },
    { label: "With won deals", value: stats?.with_won_deals },
    { label: "Without deals", value: stats?.without_deals },
  ];
  return (
    <dl aria-label="Company statistics" className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-surface px-4 py-3">
          <dt className="text-xs text-fg-subtle">{item.label}</dt>
          <dd className="text-lg font-semibold tabular-nums text-fg">{item.value === undefined ? "—" : item.value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CompaniesPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canCreate = can(active, "companies.create");
  const canDelete = can(active, "companies.delete");
  const canBulk = can(active, "companies.bulk_update");

  const { params, setParam, clear, activeFilterCount } = useListParams(ALLOWED, DEFAULTS);
  const searchParams = useSearchParams();
  const wantsNew = canCreate && searchParams?.get("new") === "1";
  const archivedView = params.archived === "true";

  const list = useCursorList<Company>(crmKeys.list("companies", params), (cursor) => listCompanies(params, cursor));
  const stats = useQuery({ queryKey: crmKeys.stats("companies"), queryFn: companyStats, staleTime: 60_000 });
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
        render: (c) => (
          <span className="inline-flex items-center gap-2">
            {c.name}
            {c.archived_at ? <Badge variant="warning">Archived</Badge> : null}
          </span>
        ),
      },
      { key: "industry", header: "Industry", sortKey: "industry", render: (c) => c.industry || <Dash /> },
      { key: "website", header: "Website", className: "hidden md:table-cell", render: (c) => (c.website ? <span className="break-all">{websiteLabel(c.website)}</span> : <Dash />) },
      { key: "phone", header: "Phone", className: "hidden lg:table-cell", render: (c) => c.phone || <Dash /> },
      { key: "owner", header: "Owner", className: "hidden lg:table-cell", render: (c) => c.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span> },
      { key: "tags", header: "Tags", className: "hidden md:table-cell", render: (c) => (c.tags.length ? <TagList tags={c.tags} /> : <Dash />) },
      { key: "contacts", header: "Contacts", className: "hidden md:table-cell text-right tabular-nums", render: (c) => c.contact_count },
      { key: "open_deals", header: "Open deals", className: "hidden lg:table-cell text-right tabular-nums", render: (c) => c.open_deal_count },
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
    [active, canDelete, archive, restore],
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
      description="Accounts you sell to, with their contacts and deals."
      action={
        canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> New company
          </Button>
        ) : null
      }
    />
  );

  return (
    <div>
      <PageHeader
        title="Companies"
        description="Accounts you sell to, with their contacts and deals."
        actions={
          canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New company
            </Button>
          ) : null
        }
      />

      <ListToolbar params={params} setParam={setParam} clear={clear} sortOptions={SORT_OPTIONS} activeFilterCount={activeFilterCount} searchPlaceholder="Search companies…">
        <IndustryFilter value={params.industry} onChange={(v) => setParam("industry", v)} />
        <Select value={params.company_size ?? "all"} onValueChange={(v) => setParam("company_size", v === "all" ? undefined : v)}>
          <SelectTrigger className="w-40" aria-label="Company size filter">
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
        isError={list.isError}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={empty}
        hasMore={list.hasMore}
        onLoadMore={() => list.loadMore()}
        isLoadingMore={list.isLoadingMore}
        caption="Companies"
      />

      <Kpis stats={stats.data} />

      <CompanyFormDialog open={createOpen || wantsNew || editing !== null} company={editing} onOpenChange={(open) => !open && closeDialog()} />
    </div>
  );
}
