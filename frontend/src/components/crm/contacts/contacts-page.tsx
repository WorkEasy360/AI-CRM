"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArchiveRestore, Archive, Contact as ContactIcon, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BulkBar } from "@/components/crm/bulk-bar";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listContacts } from "@/lib/api/crm";
import type { Contact, LifecycleStage, ListParams } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";

// The form (zod, react-hook-form, custom fields) is only needed once someone creates or edits a contact.
const ContactFormDialog = dynamic(() => import("@/components/crm/contacts/contact-form-dialog").then((m) => m.ContactFormDialog), { ssr: false });

const ALLOWED = ["q", "sort", "owner", "archived", "company", "has_company", "lifecycle", "source", "job_title", "created_from", "created_to"] as const;
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
  { value: "lifecycle", label: "Status" },
  { value: "-last_activity_at", label: "Recent activity" },
  { value: "next_activity_at", label: "Next activity soonest" },
];

const enc = encodeURIComponent;

export function ContactsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canCreate = can(active, "contacts.create");
  const canDelete = can(active, "contacts.delete");
  const canBulk = can(active, "contacts.bulk_update");

  const { params, setParam, setParams, clear, activeFilterCount } = useListParams(ALLOWED, DEFAULTS);
  const searchParams = useSearchParams();
  const wantsNew = canCreate && searchParams?.get("new") === "1";
  const archivedView = params.archived === "true";

  const list = useCursorList<Contact>(crmKeys.list("contacts", params), (cursor) => listContacts(params, cursor), true, {
    recordKey: (row) => crmKeys.record("contacts", row.id),
  });
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
        className: "min-w-40",
        render: (c) => (
          <span className="inline-flex items-center gap-2">
            {c.display_name || c.email || "Unnamed contact"}
            {c.archived_at ? <Badge variant="warning">Archived</Badge> : null}
          </span>
        ),
      },
      {
        key: "company",
        header: "Company",
        sortKey: "company",
        className: "max-w-48",
        render: (c) =>
          c.company ? (
            <Link prefetch={false} href={`/companies/${enc(c.company.id)}`} className="block truncate text-fg hover:text-primary hover:underline">
              {c.company.name}
            </Link>
          ) : (
            <Dash />
          ),
      },
      {
        key: "email",
        header: "Email",
        sortKey: "email",
        className: "hidden lg:table-cell max-w-56",
        render: (c) =>
          c.email ? (
            <a href={`mailto:${c.email}`} className="block truncate text-fg hover:text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
              {c.email}
            </a>
          ) : (
            <Dash />
          ),
      },
      { key: "phone", header: "Phone", className: "hidden md:table-cell whitespace-nowrap", render: (c) => c.phone || <Dash /> },
      { key: "lifecycle", header: "Status", sortKey: "lifecycle", render: (c) => <LifecycleBadge stage={c.lifecycle_stage} /> },
      {
        key: "owner",
        header: "Owner",
        className: "hidden xl:table-cell",
        render: (c) => c.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span>,
      },
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
        className: "hidden sm:table-cell max-w-48",
        render: (c) => <NextActivityCell at={c.next_activity_at} title={c.next_activity_title} />,
      },
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
      description="Add the people you sell to. Link them to companies and deals as you go."
      action={
        canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> Contact
          </Button>
        ) : null
      }
    />
  );

  return (
    <div>
      <PageHeader title="Contacts" />

      <ListToolbar
        params={params}
        setParam={setParam}
        setParams={setParams}
        clear={clear}
        sortOptions={SORT_OPTIONS}
        activeFilterCount={activeFilterCount}
        entityLabel="contacts"
        searchPlaceholder="Search contacts…"
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> Contact
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
        <Select value={params.has_company ?? "all"} onValueChange={(v) => setParam("has_company", v === "all" ? undefined : v)}>
          <SelectTrigger className="h-8 w-40" aria-label="Company filter">
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
        isRefreshing={list.isPlaceholderData}
        isError={list.isError}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={empty}
        hasMore={list.hasMore}
        onLoadMore={() => list.loadMore()}
        isLoadingMore={list.isLoadingMore}
        caption="Contacts"
      />

      <ContactFormDialog open={createOpen || wantsNew || editing !== null} contact={editing} onOpenChange={(open) => !open && closeDialog()} />
    </div>
  );
}
