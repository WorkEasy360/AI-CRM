"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Contact as ContactIcon, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { CompanyFormDialog } from "@/components/crm/companies/company-form-dialog";
import { CustomFieldsSummary, useCustomFields } from "@/components/crm/custom-fields-form";
import { DataTable, type Column } from "@/components/crm/data-table";
import { NotesPanel } from "@/components/crm/notes-panel";
import { Facts, RecordPage, RecordPageError, RecordPageSkeleton, Section } from "@/components/crm/record-page";
import { TagList, TagPicker } from "@/components/crm/tag-picker";
import { Timeline } from "@/components/crm/timeline";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { getCompany, listContacts } from "@/lib/api/crm";
import type { Company, Contact } from "@/lib/api/crm-types";
import { formatAddress, formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDateTime } from "@/lib/utils";

const enc = encodeURIComponent;

const CONTACT_COLUMNS: Column<Contact>[] = [
  { key: "name", header: "Name", render: (c) => c.display_name || c.email || "Unnamed contact" },
  { key: "email", header: "Email", render: (c) => (c.email ? <span className="break-all">{c.email}</span> : <span className="text-fg-subtle">—</span>) },
  { key: "job_title", header: "Job title", className: "hidden md:table-cell", render: (c) => c.job_title || <span className="text-fg-subtle">—</span> },
  { key: "tags", header: "Tags", className: "hidden lg:table-cell", render: (c) => (c.tags.length ? <TagList tags={c.tags} /> : <span className="text-fg-subtle">—</span>) },
  { key: "open_deals", header: "Open deals", className: "hidden md:table-cell text-right tabular-nums", render: (c) => c.open_deal_count },
];

function CompanyContacts({ companyId, canCreate }: { companyId: string; canCreate: boolean }) {
  const params = React.useMemo(() => ({ company: companyId, sort: "name" }), [companyId]);
  const contacts = useCursorList<Contact>(crmKeys.list("contacts", params), (cursor) => listContacts(params, cursor));
  return (
    <div className="flex flex-col gap-3">
      {canCreate && contacts.items.length > 0 ? (
        <div className="flex justify-end">
          <Button asChild variant="secondary" size="sm">
            <Link href="/contacts?new=1">
              <Plus /> New contact
            </Link>
          </Button>
        </div>
      ) : null}
      <DataTable
        rows={contacts.items}
        columns={CONTACT_COLUMNS}
        rowHref={(c) => `/contacts/${enc(c.id)}`}
        isPending={contacts.isPending}
        isError={contacts.isError}
        error={contacts.error}
        onRetry={() => contacts.refetch()}
        empty={
          <EmptyState
            icon={<ContactIcon />}
            title="No contacts yet"
            description="People linked to this company will appear here."
            className="py-8"
            action={
              canCreate ? (
                <Button asChild variant="secondary">
                  <Link href="/contacts?new=1">
                    <Plus /> New contact
                  </Link>
                </Button>
              ) : null
            }
          />
        }
        hasMore={contacts.hasMore}
        onLoadMore={() => contacts.loadMore()}
        isLoadingMore={contacts.isLoadingMore}
        caption="Contacts at this company"
      />
    </div>
  );
}

export function CompanyDetailPage({ id }: { id: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const query = useQuery({ queryKey: crmKeys.record("companies", id), queryFn: () => getCompany(id) });
  const { definitions } = useCustomFields("company");
  const { archive, restore } = useArchiveRestore("company");
  const [editOpen, setEditOpen] = React.useState(false);

  if (query.isPending) return <RecordPageSkeleton />;
  if (query.isError) return <RecordPageError error={query.error} backHref="/companies" backLabel="Companies" />;

  const company: Company = query.data;
  const canEdit = canEditRecord(active, "companies", company.owner?.id);
  const canDelete = can(active, "companies.delete");
  const canCreateContact = can(active, "contacts.create");

  const overview = (
    <div className="flex flex-col gap-4">
      <Section title="Details">
        <Facts
          items={[
            { label: "Website", value: company.website },
            { label: "Phone", value: company.phone },
            { label: "Industry", value: company.industry },
            { label: "Company size", value: company.company_size ? `${company.company_size} employees` : "" },
            { label: "Annual revenue", value: company.annual_revenue ? formatMoney(company.annual_revenue, company.revenue_currency || active?.organization.base_currency) : "" },
            { label: "Source", value: company.source },
            { label: "Address", value: formatAddress(company.address) },
            { label: "Contacts", value: company.contact_count.toLocaleString() },
            { label: "Open deals", value: company.open_deal_count.toLocaleString() },
          ]}
        />
      </Section>
      {definitions.length > 0 ? (
        <Section title="Custom fields">
          <CustomFieldsSummary definitions={definitions} value={company.custom_data} />
        </Section>
      ) : null}
      {company.description ? (
        <Section title="Description">
          <p className="whitespace-pre-wrap break-words text-sm">{company.description}</p>
        </Section>
      ) : null}
    </div>
  );

  return (
    <>
      <RecordPage
        backHref="/companies"
        backLabel="Companies"
        title={company.name}
        subtitle={company.industry || undefined}
        archived={Boolean(company.archived_at)}
        actions={
          <>
            {canEdit ? (
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
            {canDelete ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {company.archived_at ? (
                    <DropdownMenuItem onSelect={() => restore.mutate(company.id)}>
                      <ArchiveRestore /> Restore
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem destructive onSelect={() => archive.mutate(company.id)}>
                      <Archive /> Archive
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
        tabs={[
          { value: "overview", label: "Overview", content: overview },
          { value: "contacts", label: "Contacts", content: <CompanyContacts companyId={company.id} canCreate={canCreateContact} /> },
          { value: "notes", label: "Notes", content: <NotesPanel entity="company" recordId={company.id} /> },
          { value: "timeline", label: "Timeline", content: <Timeline entity="company" recordId={company.id} /> },
        ]}
        aside={
          <>
            <Section title="Owner">
              <p className="text-sm">{company.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span>}</p>
            </Section>
            <Section title="Tags">
              <TagPicker entity="company" recordId={company.id} current={company.tags} disabled={!canEdit} />
            </Section>
            <Section title="Record">
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt className="text-xs text-fg-subtle">Created</dt>
                  <dd>{formatDateTime(company.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-subtle">Updated</dt>
                  <dd>{formatDateTime(company.updated_at)}</dd>
                </div>
                {company.archived_at ? (
                  <div>
                    <dt className="text-xs text-fg-subtle">Archived</dt>
                    <dd>{formatDateTime(company.archived_at)}</dd>
                  </div>
                ) : null}
              </dl>
            </Section>
          </>
        }
      />
      <CompanyFormDialog open={editOpen} company={company} onOpenChange={setEditOpen} />
    </>
  );
}
