"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RecordActivities } from "@/components/activities/record-activities";
import { ContactFormDialog } from "@/components/crm/contacts/contact-form-dialog";
import { ContactHeader } from "@/components/crm/contacts/contact-header";
import { RecordDeals } from "@/components/crm/contacts/record-deals";
import { Disclosure, RecordLayout } from "@/components/crm/contacts/record-layout";
import { CustomFieldsSummary, useCustomFields } from "@/components/crm/custom-fields-form";
import { NotesPanel } from "@/components/crm/notes-panel";
import { Facts, RecordPageError, RecordPageSkeleton, Section } from "@/components/crm/record-page";
import { TagPicker } from "@/components/crm/tag-picker";
import { Timeline } from "@/components/crm/timeline";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { EmailHistory } from "@/components/messaging/email-history";
import { WhatsAppConversation } from "@/components/messaging/whatsapp-conversation";
import { EmptyState } from "@/components/ui/empty-state";
import { getContact } from "@/lib/api/crm";
import type { Contact } from "@/lib/api/crm-types";
import { formatAddress } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

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
  const canCreateDeal = can(active, "deals.create");
  const name = contact.display_name || contact.email || "Unnamed contact";
  const record = { contact: { id: contact.id, name }, company: contact.company, deal: null };

  const newDealQs = new URLSearchParams({ new: "1", contact: contact.id });
  if (contact.company) newDealQs.set("company", contact.company.id);

  const hasDetails = Boolean(
    contact.source || contact.description || definitions.length > 0 || Object.values(contact.address ?? {}).some(Boolean),
  );

  return (
    <>
      <RecordLayout
        backHref="/contacts"
        backLabel="Contacts"
        header={
          <ContactHeader
            contact={contact}
            canEdit={canEdit}
            canDelete={canDelete}
            onEdit={() => setEditOpen(true)}
            onArchive={() => archive.mutate(contact.id)}
            onRestore={() => restore.mutate(contact.id)}
          />
        }
        defaultTab="timeline"
        tabs={[
          { value: "timeline", label: "Timeline", content: <Timeline entity="contact" recordId={contact.id} /> },
          {
            value: "deals",
            label: "Deals",
            content: (
              <RecordDeals
                filter={{ contact: contact.id }}
                newDealHref={`/pipeline?${newDealQs.toString()}`}
                canCreate={canCreateDeal}
                emptyDescription="Deals where this person is the primary contact will appear here."
              />
            ),
          },
          {
            value: "activities",
            label: "Activities",
            content: can(active, "activities.view") ? <RecordActivities entity="contact" recordId={contact.id} record={record} /> : null,
          },
          {
            value: "emails",
            label: "Emails",
            content: can(active, "email.view") ? (
              <EmailHistory entity="contact" recordId={contact.id} contact={{ id: contact.id, name, email: contact.email }} company={contact.company} />
            ) : null,
          },
          {
            value: "whatsapp",
            label: "WhatsApp",
            content: can(active, "whatsapp.view") ? (
              contact.phone ? (
                <WhatsAppConversation contact={{ id: contact.id, name, phone: contact.phone, whatsapp_opt_in: contact.whatsapp_opt_in }} />
              ) : (
                <EmptyState
                  title="No phone number"
                  description="Add a phone number to this contact to start a WhatsApp conversation."
                  className="py-8"
                />
              )
            ) : null,
          },
          {
            value: "calls",
            label: "Calls",
            content: can(active, "activities.view") ? (
              <RecordActivities entity="contact" recordId={contact.id} record={record} kinds={["call"]} title="Calls" emptyDescription="Log a call to keep the conversation history here." />
            ) : null,
          },
          {
            value: "meetings",
            label: "Meetings",
            content: can(active, "activities.view") ? (
              <RecordActivities entity="contact" recordId={contact.id} record={record} kinds={["meeting"]} title="Meetings" emptyDescription="Schedule a meeting with this person." />
            ) : null,
          },
          { value: "notes", label: "Notes", content: <NotesPanel entity="contact" recordId={contact.id} /> },
        ]}
        aside={
          <>
            <Section title="Tags">
              <TagPicker entity="contact" recordId={contact.id} current={contact.tags} disabled={!canEdit} />
            </Section>
            {hasDetails ? (
              <Disclosure title="Details" bordered defaultOpen>
                <div className="flex flex-col gap-3">
                  <Facts
                    items={[
                      { label: "Source", value: contact.source },
                      { label: "Address", value: formatAddress(contact.address) },
                      { label: "WhatsApp consent", value: contact.whatsapp_opt_in ? "Given" : "Not given" },
                    ]}
                  />
                  {definitions.length > 0 ? <CustomFieldsSummary definitions={definitions} value={contact.custom_data} /> : null}
                  {contact.description ? <p className="whitespace-pre-wrap break-words text-sm">{contact.description}</p> : null}
                </div>
              </Disclosure>
            ) : null}
            <Section title="Record">
              <dl className="grid gap-1.5 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-subtle">Created</dt>
                  <dd>{formatDateTime(contact.created_at)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-subtle">Updated</dt>
                  <dd>{formatDateTime(contact.updated_at)}</dd>
                </div>
                {contact.lifecycle_changed_at ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-fg-subtle">Status changed</dt>
                    <dd>{formatDateTime(contact.lifecycle_changed_at)}</dd>
                  </div>
                ) : null}
                {contact.archived_at ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-fg-subtle">Archived</dt>
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
