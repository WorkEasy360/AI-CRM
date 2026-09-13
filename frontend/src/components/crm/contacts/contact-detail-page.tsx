"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Handshake, MoreHorizontal, Pencil } from "lucide-react";
import { ContactFormDialog } from "@/components/crm/contacts/contact-form-dialog";
import { CustomFieldsSummary, useCustomFields } from "@/components/crm/custom-fields-form";
import { DataTable, type Column } from "@/components/crm/data-table";
import { NotesPanel } from "@/components/crm/notes-panel";
import { Facts, RecordPage, RecordPageError, RecordPageSkeleton, Section } from "@/components/crm/record-page";
import { TagPicker } from "@/components/crm/tag-picker";
import { Timeline } from "@/components/crm/timeline";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { getContact, listDeals } from "@/lib/api/crm";
import type { Contact, Deal } from "@/lib/api/crm-types";
import { formatAddress, formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDate, formatDateTime } from "@/lib/utils";

const enc = encodeURIComponent;

function statusVariant(status: Deal["status"]): "success" | "danger" | "primary" {
  if (status === "won") return "success";
  if (status === "lost") return "danger";
  return "primary";
}

const DEAL_COLUMNS: Column<Deal>[] = [
  { key: "name", header: "Deal", render: (d) => d.name },
  { key: "stage", header: "Stage", render: (d) => d.stage.name },
  { key: "amount", header: "Amount", className: "text-right tabular-nums", render: (d) => formatMoney(d.amount, d.currency) },
  { key: "status", header: "Status", className: "hidden md:table-cell", render: (d) => <Badge variant={statusVariant(d.status)}>{d.status}</Badge> },
  { key: "close", header: "Expected close", className: "hidden md:table-cell", render: (d) => formatDate(d.expected_close_date) },
];

function ContactDeals({ contactId }: { contactId: string }) {
  const params = React.useMemo(() => ({ contact: contactId }), [contactId]);
  const deals = useCursorList<Deal>(crmKeys.list("deals", params), (cursor) => listDeals(params, cursor));
  return (
    <DataTable
      rows={deals.items}
      columns={DEAL_COLUMNS}
      rowHref={(d) => `/deals/${enc(d.id)}`}
      isPending={deals.isPending}
      isError={deals.isError}
      error={deals.error}
      onRetry={() => deals.refetch()}
      empty={<EmptyState icon={<Handshake />} title="No deals yet" description="Deals where this person is the primary contact will appear here." className="py-8" />}
      hasMore={deals.hasMore}
      onLoadMore={() => deals.loadMore()}
      isLoadingMore={deals.isLoadingMore}
      caption="Deals for this contact"
    />
  );
}

export function ContactDetailPage({ id }: { id: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const query = useQuery({ queryKey: crmKeys.record("contacts", id), queryFn: () => getContact(id) });
  const { definitions } = useCustomFields("contact");
  const { archive, restore } = useArchiveRestore("contact");
  const [editOpen, setEditOpen] = React.useState(false);

  if (query.isPending) return <RecordPageSkeleton />;
  if (query.isError) return <RecordPageError error={query.error} backHref="/contacts" backLabel="Contacts" />;

  const contact: Contact = query.data;
  const canEdit = canEditRecord(active, "contacts", contact.owner?.id);
  const canDelete = can(active, "contacts.delete");
  const title = contact.display_name || contact.email || "Unnamed contact";
  const subtitle = [contact.job_title, contact.company?.name].filter(Boolean).join(" @ ");

  const overview = (
    <div className="flex flex-col gap-4">
      <Section title="Details">
        <Facts
          items={[
            { label: "Email", value: contact.email },
            { label: "Phone", value: contact.phone },
            { label: "Job title", value: contact.job_title },
            {
              label: "Company",
              value: contact.company ? (
                <Link href={`/companies/${enc(contact.company.id)}`} className="text-primary hover:underline">
                  {contact.company.name}
                </Link>
              ) : (
                ""
              ),
            },
            { label: "Source", value: contact.source },
            { label: "Address", value: formatAddress(contact.address) },
            { label: "Open deals", value: contact.open_deal_count.toLocaleString() },
            { label: "Last activity", value: contact.last_activity_at ? formatDateTime(contact.last_activity_at) : "" },
          ]}
        />
      </Section>
      {definitions.length > 0 ? (
        <Section title="Custom fields">
          <CustomFieldsSummary definitions={definitions} value={contact.custom_data} />
        </Section>
      ) : null}
      {contact.description ? (
        <Section title="Description">
          <p className="whitespace-pre-wrap break-words text-sm">{contact.description}</p>
        </Section>
      ) : null}
    </div>
  );

  return (
    <>
      <RecordPage
        backHref="/contacts"
        backLabel="Contacts"
        title={title}
        subtitle={subtitle || undefined}
        archived={Boolean(contact.archived_at)}
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
                  {contact.archived_at ? (
                    <DropdownMenuItem onSelect={() => restore.mutate(contact.id)}>
                      <ArchiveRestore /> Restore
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem destructive onSelect={() => archive.mutate(contact.id)}>
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
          { value: "notes", label: "Notes", content: <NotesPanel entity="contact" recordId={contact.id} /> },
          { value: "timeline", label: "Timeline", content: <Timeline entity="contact" recordId={contact.id} /> },
          { value: "deals", label: "Deals", content: <ContactDeals contactId={contact.id} /> },
        ]}
        aside={
          <>
            <Section title="Owner">
              <p className="text-sm">{contact.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span>}</p>
            </Section>
            <Section title="Tags">
              <TagPicker entity="contact" recordId={contact.id} current={contact.tags} disabled={!canEdit} />
            </Section>
            <Section title="Record">
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt className="text-xs text-fg-subtle">Created</dt>
                  <dd>{formatDateTime(contact.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-subtle">Updated</dt>
                  <dd>{formatDateTime(contact.updated_at)}</dd>
                </div>
                {contact.archived_at ? (
                  <div>
                    <dt className="text-xs text-fg-subtle">Archived</dt>
                    <dd>{formatDateTime(contact.archived_at)}</dd>
                  </div>
                ) : null}
              </dl>
            </Section>
          </>
        }
      />
      <ContactFormDialog open={editOpen} contact={contact} onOpenChange={setEditOpen} />
    </>
  );
}
