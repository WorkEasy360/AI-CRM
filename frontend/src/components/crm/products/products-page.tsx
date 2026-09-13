"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, MoreHorizontal, Package, Pencil, Plus, Upload } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { DataTable, type Column } from "@/components/crm/data-table";
import { ListToolbar, type SortOption } from "@/components/crm/list-toolbar";
import { ProductFormDialog } from "@/components/crm/products/product-form-dialog";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listProducts } from "@/lib/api/crm";
import type { ListParams, Product } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";

const ALLOWED = ["q", "sort", "owner", "archived", "status", "currency", "price_min", "price_max"] as const;
const DEFAULTS: ListParams = { sort: "name" };
const SORT_OPTIONS: SortOption[] = [
  { value: "name", label: "Name A–Z" },
  { value: "-name", label: "Name Z–A" },
  { value: "sku", label: "SKU A–Z" },
  { value: "unit_price", label: "Price low–high" },
  { value: "-unit_price", label: "Price high–low" },
  { value: "-updated_at", label: "Recently updated" },
  { value: "-created_at", label: "Newest first" },
];

const enc = encodeURIComponent;

function Dash() {
  return <span className="text-fg-subtle">—</span>;
}

export function StatusBadge({ status }: { status: Product["status"] }) {
  return <Badge variant={status === "active" ? "success" : "neutral"}>{status === "active" ? "Active" : "Inactive"}</Badge>;
}

export function ProductsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canCreate = can(active, "products.create");
  const canDelete = can(active, "products.delete");
  const canImport = can(active, "products.import");

  const { params, setParam, setParams, clear, activeFilterCount } = useListParams(ALLOWED, DEFAULTS);
  const searchParams = useSearchParams();
  const wantsNew = canCreate && searchParams?.get("new") === "1";

  const list = useCursorList<Product>(crmKeys.list("products", params), (cursor) => listProducts(params, cursor), true, {
    recordKey: (row) => crmKeys.record("products", row.id),
  });
  const { archive, restore } = useArchiveRestore("product");

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Product | null>(null);

  const closeDialog = () => {
    setCreateOpen(false);
    setEditing(null);
    if (wantsNew) setParam("new", undefined);
  };

  const columns = React.useMemo<Column<Product>[]>(
    () => [
      {
        key: "name",
        header: "Product name",
        sortKey: "name",
        className: "min-w-44",
        render: (p) => (
          <span className="inline-flex items-center gap-2">
            {p.name}
            {p.archived_at ? <Badge variant="warning">Archived</Badge> : null}
          </span>
        ),
      },
      { key: "sku", header: "SKU", sortKey: "sku", render: (p) => (p.sku ? <span className="font-mono text-xs">{p.sku}</span> : <Dash />) },
      { key: "price", header: "Unit price", sortKey: "unit_price", className: "text-right tabular-nums whitespace-nowrap", render: (p) => formatMoney(p.unit_price, p.currency) },
      { key: "status", header: "Status", render: (p) => <StatusBadge status={p.status} /> },
      { key: "owner", header: "Owner", className: "hidden md:table-cell", render: (p) => p.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span> },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        className: "w-10 text-right",
        render: (p) => {
          const editable = canEditRecord(active, "products", p.owner?.id);
          if (!editable && !canDelete) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {editable ? (
                  <DropdownMenuItem onSelect={() => setEditing(p)}>
                    <Pencil /> Edit
                  </DropdownMenuItem>
                ) : null}
                {canDelete && p.archived_at ? (
                  <DropdownMenuItem onSelect={() => restore.mutate(p.id)}>
                    <ArchiveRestore /> Restore
                  </DropdownMenuItem>
                ) : null}
                {canDelete && !p.archived_at ? (
                  <DropdownMenuItem destructive onSelect={() => archive.mutate(p.id)}>
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
      title="No products match"
      description="Try different keywords or clear the filters."
      action={
        <Button variant="secondary" onClick={clear}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={<Package />}
      title="Track what you sell."
      description="Add your products and services with their prices, so deals can carry line items and totals."
      className="py-16"
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> Add product
            </Button>
          ) : null}
          {canImport ? (
            <Button asChild variant="secondary">
              <Link href="/settings/data">
                <Upload /> Import products
              </Link>
            </Button>
          ) : null}
        </div>
      }
    />
  );

  return (
    <div>
      <PageHeader title="Products" />

      <ListToolbar
        params={params}
        setParam={setParam}
        setParams={setParams}
        clear={clear}
        sortOptions={SORT_OPTIONS}
        activeFilterCount={activeFilterCount}
        entityLabel="products"
        searchPlaceholder="Search products…"
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> Product
            </Button>
          ) : null
        }
      >
        <Select value={params.status ?? "all"} onValueChange={(v) => setParam("status", v === "all" ? undefined : v)}>
          <SelectTrigger className="h-8 w-36" aria-label="Status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </ListToolbar>

      <DataTable
        rows={list.items}
        columns={columns}
        sort={params.sort}
        onSort={(s) => setParam("sort", s)}
        rowHref={(p) => `/products/${enc(p.id)}`}
        isPending={list.isPending}
        isRefreshing={list.isPlaceholderData}
        isError={list.isError}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={empty}
        hasMore={list.hasMore}
        onLoadMore={() => list.loadMore()}
        isLoadingMore={list.isLoadingMore}
        caption="Products"
      />

      <ProductFormDialog open={createOpen || wantsNew || editing !== null} product={editing} onOpenChange={(open) => !open && closeDialog()} />
    </div>
  );
}
