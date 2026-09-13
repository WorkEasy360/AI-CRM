"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArchiveRestore, Archive, Contact as ContactIcon, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BulkBar } from "@/components/crm/bulk-bar";
import { ContactFormDialog } from "@/components/crm/contacts/contact-form-dialog";
import { DataTable, useSelection, type Column } from "@/components/crm/data-table";
import { ListToolbar, type SortOption } from "@/components/crm/list-toolbar";
import { TagList } from "@/components/crm/tag-picker";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { contactStats, listContacts } from "@/lib/api/crm";
import type { Contact, ContactStats, ListParams } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDate } from "@/lib/utils";

const ALLOWED = ["q", "sort", "owner", "archived", "company", "has_company", "source", "job_title", "created_from", "created_to"] as const;
const DEFAULTS: ListParams = { sort: "-created_at" };
const SORT_OPTIONS: SortOption[] = [
  { value: "-created_at", label: "Newest first" },
  { value: "created_at", label: "Oldest first" },
  { value: "-updated_at", label: "Recently updated" },
  { value: "name", label: "Last name A–Z" },
  { value: "-name", label: "Last name Z–A" },
  { value: "first_name", label: "First name A–Z" },
  { value: "email", label: "Email A–Z" },
  { value: "company", label: "Company A–Z" },
];

const enc = encodeURIComponent;

function Dash() {
  return <span className="text-fg-subtle">—</span>;
}

function Kpis({ stats }: { stats: ContactStats | undefined }) {
  const items = [
    { label: "Total contacts", value: stats?.total },
    { label: "With open deals", value: stats?.with_open_deals },
    { label: "Without deals", value: stats?.without_deals },
    { label: "Untouched", value: stats?.untouched },
  ];
  return (
    <dl aria-label="Contact statistics" className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-surface px-4 py-3">
          <dt className="text-xs text-fg-subtle">{item.label}</dt>
          <dd className="text-lg font-semibold tabular-nums text-fg">{item.value === undefined ? "—" : item.value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ContactsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canCreate = can(active, "contacts.create");
  const canDelete = can(active, "contacts.delete");
  const canBulk = can(active, "contacts.bulk_update");

  const { params, setParam, clear, activeFilterCount } = useListParams(ALLOWED, DEFAULTS);
  const searchParams = useSearchParams();
  const wantsNew = canCreate && searchParams?.get("new") === "1";
  const archivedView = params.archived === "true";

  const list = useCursorList<Contact>(crmKeys.list("contacts", params), (cursor) => listContacts(params, cursor));
  const stats = useQuery({ queryKey: crmKeys.stats("contacts"), queryFn: contactStats, staleTime: 60_000 });
  const selection = useSelection();
  const { archive, restore } = useArchiveRestore("contact");

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Contact | null>(null);

  const closeDialog = () => {
    setCreateOpen(false);
    setEditing(null);
    if (wantsNew) setParam("new", undefined);
  };

  const { clear: clearSelection } = selection;
  React.useEffect(() => {
    clearSelection();
  }, [params, clearSelection]);

  const columns = React.useMemo<Column<Contact>[]>(
    () => [
      {
        key: "name",
        header: "Name",
        sortKey: "name",
        render: (c) => (
          <span className="inline-flex items-center gap-2">
            {c.display_name || c.email || "Unnamed contact"}
            {c.archived_at ? <Badge variant="warning">Archived</Badge> : null}
          </span>
        ),
      },
      { key: "email", header: "Email", sortKey: "email", render: (c) => (c.email ? <span className="break-all">{c.email}</span> : <Dash />) },
      { key: "phone", header: "Phone", className: "hidden md:table-cell", render: (c) => c.phone || <Dash /> },
      {
        key: "company",
        header: "Company",
        sortKey: "company",
        render: (c) =>
          c.company ? (
            <Link href={`/companies/${enc(c.company.id)}`} className="text-fg hover:text-primary hover:underline">
              {c.company.name}
            </Link>
          ) : (
            <Dash />
          ),
      },
      { key: "owner", header: "Owner", className: "hidden lg:table-cell", render: (c) => c.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span> },
      { key: "tags", header: "Tags", className: "hidden md:table-cell", render: (c) => (c.tags.length ? <TagList tags={c.tags} /> : <Dash />) },
      { key: "open_deals", header: "Open deals", className: "hidden lg:table-cell text-right tabular-nums", render: (c) => c.open_deal_count },
      { key: "created", header: "Created", sortKey: "created_at", className: "hidden xl:table-cell", render: (c) => formatDate(c.created_at) },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        className: "w-10 text-right",
        render: (c) => {
          const editable = canEditRecord(active, "contacts", c.owner?.id);
          if (!editable && !canDelete) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.display_name || c.email || "contact"}`}>
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
      title="No contacts match"
      description="Try different keywords or clear the filters."
      action={
        <Button variant="secondary" onClick={clear}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={<ContactIcon />}
      title="No contacts yet"
      description="People you work with, linked to companies and deals."
      action={
        canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> New contact
          </Button>
        ) : null
      }
    />
  );

  return (
    <div>
      <PageHeader
        title="Contacts"
        description="People you work with, linked to companies and deals."
        actions={
          canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New contact
            </Button>
          ) : null
        }
      />

      <ListToolbar params={params} setParam={setParam} clear={clear} sortOptions={SORT_OPTIONS} activeFilterCount={activeFilterCount} searchPlaceholder="Search contacts…">
        <Select value={params.has_company ?? "all"} onValueChange={(v) => setParam("has_company", v === "all" ? undefined : v)}>
          <SelectTrigger className="w-40" aria-label="Company filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any company</SelectItem>
            <SelectItem value="true">Has a company</SelectItem>
            <SelectItem value="false">No company</SelectItem>
          </SelectContent>
        </Select>
      </ListToolbar>

      {canBulk ? <BulkBar entity="contact" selected={selection.selected} onClear={selection.clear} archivedView={archivedView} /> : null}

      <DataTable
        rows={list.items}
        columns={columns}
        sort={params.sort}
        onSort={(s) => setParam("sort", s)}
        rowHref={(c) => `/contacts/${enc(c.id)}`}
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
        caption="Contacts"
      />

      <Kpis stats={stats.data} />

      <ContactFormDialog open={createOpen || wantsNew || editing !== null} contact={editing} onOpenChange={(open) => !open && closeDialog()} />
    </div>
  );
}
