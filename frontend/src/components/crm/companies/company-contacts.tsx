"use client";

import * as React from "react";
import { Contact as ContactIcon, MessageCircle, Plus } from "lucide-react";
import { ContactFormDialog } from "@/components/crm/contacts/contact-form-dialog";
import { Dash, LastActivityCell } from "@/components/crm/contacts/activity-cells";
import { DataTable, type Column } from "@/components/crm/data-table";
import { LifecycleBadge } from "@/components/crm/lifecycle-badge";
import { WhatsAppConversation } from "@/components/messaging/whatsapp-conversation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { listContacts } from "@/lib/api/crm";
import type { Company, Contact } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { useCursorList } from "@/lib/use-cursor-list";

const enc = encodeURIComponent;

const CONTACT_COLUMNS: Column<Contact>[] = [
  { key: "name", header: "Name", className: "min-w-40", render: (c) => c.display_name || c.email || "Unnamed contact" },
  { key: "job_title", header: "Job title", className: "hidden md:table-cell", render: (c) => c.job_title || <Dash /> },
  { key: "email", header: "Email", className: "hidden lg:table-cell max-w-56", render: (c) => (c.email ? <span className="block truncate">{c.email}</span> : <Dash />) },
  { key: "phone", header: "Phone", className: "hidden md:table-cell whitespace-nowrap", render: (c) => c.phone || <Dash /> },
  { key: "lifecycle", header: "Status", render: (c) => <LifecycleBadge stage={c.lifecycle_stage} /> },
  { key: "last_activity", header: "Last activity", className: "hidden sm:table-cell whitespace-nowrap", render: (c) => <LastActivityCell value={c.last_activity_at} /> },
];

/** Contacts linked to one company (shared by the Contacts and WhatsApp tabs, so the list is fetched once). */
export function useCompanyContacts(companyId: string) {
  const params = React.useMemo(() => ({ company: companyId, sort: "name" }), [companyId]);
  return useCursorList<Contact>(crmKeys.list("contacts", params), (cursor) => listContacts(params, cursor), true, {
    recordKey: (row) => crmKeys.record("contacts", row.id),
  });
}

/** Contacts tab: table plus a "New contact" dialog prefilled with the company. */
export function CompanyContacts({ company, canCreate }: { company: Company; canCreate: boolean }) {
  const contacts = useCompanyContacts(company.id);
  const [createOpen, setCreateOpen] = React.useState(false);
  const preset = React.useMemo(() => ({ company: { id: company.id, name: company.name } }), [company.id, company.name]);
  const newContact = (
    <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
      <Plus /> New contact
    </Button>
  );
  return (
    <div className="flex flex-col gap-3">
      {canCreate && contacts.items.length > 0 ? <div className="flex justify-end">{newContact}</div> : null}
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
            description="People who work here will appear once they are linked to this company."
            className="py-8"
            action={canCreate ? newContact : null}
          />
        }
        hasMore={contacts.hasMore}
        onLoadMore={() => contacts.loadMore()}
        isLoadingMore={contacts.isLoadingMore}
        caption="Contacts at this company"
      />
      <ContactFormDialog open={createOpen} onOpenChange={setCreateOpen} defaults={preset} />
    </div>
  );
}

/**
 * WhatsApp tab for a company: conversations live on contacts, so pick a contact with a phone number
 * (the first one by default) and show that thread; otherwise point to the Contacts tab.
 */
export function CompanyWhatsApp({ companyId }: { companyId: string }) {
  const contacts = useCompanyContacts(companyId);
  const withPhone = React.useMemo(() => contacts.items.filter((c) => c.phone), [contacts.items]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = withPhone.find((c) => c.id === selectedId) ?? withPhone[0] ?? null;

  if (contacts.isPending) return <SkeletonRows rows={3} />;
  if (!selected) {
    return (
      <EmptyState
        icon={<MessageCircle />}
        title="No contact with a phone number"
        description="WhatsApp conversations belong to people. Add a phone number to one of this company's contacts (Contacts tab) to start messaging."
        className="py-8"
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {withPhone.length > 1 ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">Conversation with</span>
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger className="h-8 w-56" aria-label="Contact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {withPhone.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.display_name || c.email || c.phone}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">
          Conversation with <span className="font-medium text-fg">{selected.display_name || selected.email || selected.phone}</span>
        </p>
      )}
      <WhatsAppConversation
        key={selected.id}
        contact={{ id: selected.id, name: selected.display_name || selected.email || selected.phone, phone: selected.phone, whatsapp_opt_in: selected.whatsapp_opt_in }}
      />
    </div>
  );
}
