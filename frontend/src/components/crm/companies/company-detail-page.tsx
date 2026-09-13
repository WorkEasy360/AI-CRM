"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RecordActivities } from "@/components/activities/record-activities";
import { CompanyContacts, CompanyWhatsApp } from "@/components/crm/companies/company-contacts";
import { CompanyFormDialog } from "@/components/crm/companies/company-form-dialog";
import { CompanyHeader, CompanySummary } from "@/components/crm/companies/company-summary";
import { RecordDeals } from "@/components/crm/contacts/record-deals";
import { Disclosure, RecordLayout } from "@/components/crm/contacts/record-layout";
import { CustomFieldsSummary, useCustomFields } from "@/components/crm/custom-fields-form";
import { NotesPanel } from "@/components/crm/notes-panel";
import { Facts, RecordPageError, RecordPageSkeleton, Section } from "@/components/crm/record-page";
import { TagPicker } from "@/components/crm/tag-picker";
import { Timeline } from "@/components/crm/timeline";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { EmailHistory } from "@/components/messaging/email-history";
import { getCompany } from "@/lib/api/crm";
import type { Company } from "@/lib/api/crm-types";
import { formatAddress, formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

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
  const canCreateDeal = can(active, "deals.create");
  const baseCurrency = active?.organization.base_currency ?? "USD";
  const record = { contact: null, company: { id: company.id, name: company.name }, deal: null };

  const hasDetails = Boolean(
    company.company_size ||
      company.annual_revenue ||
      company.source ||
      company.description ||
      definitions.length > 0 ||
      Object.values(company.address ?? {}).some(Boolean),
  );

  return (
    <>
      <RecordLayout
        backHref="/companies"
        backLabel="Companies"
        header={
          <div className="flex flex-col gap-4">
            <CompanyHeader
              company={company}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={() => setEditOpen(true)}
              onArchive={() => archive.mutate(company.id)}
              onRestore={() => restore.mutate(company.id)}
            />
            <CompanySummary company={company} currency={baseCurrency} />
          </div>
        }
        tabs={[
          { value: "contacts", label: "Contacts", content: <CompanyContacts company={company} canCreate={canCreateContact} /> },
          {
            value: "deals",
            label: "Deals",
            content: (
              <RecordDeals
                filter={{ company: company.id }}
                newDealHref={`/pipeline?new=1&company=${encodeURIComponent(company.id)}`}
                canCreate={canCreateDeal}
                emptyDescription="Deals with this company will appear here."
              />
            ),
          },
          {
            value: "activities",
            label: "Activities",
            content: can(active, "activities.view") ? <RecordActivities entity="company" recordId={company.id} record={record} /> : null,
          },
          {
            value: "emails",
            label: "Emails",
            content: can(active, "email.view") ? <EmailHistory entity="company" recordId={company.id} company={{ id: company.id, name: company.name }} /> : null,
          },
          { value: "whatsapp", label: "WhatsApp", content: can(active, "whatsapp.view") ? <CompanyWhatsApp companyId={company.id} /> : null },
          { value: "notes", label: "Notes", content: <NotesPanel entity="company" recordId={company.id} /> },
          { value: "timeline", label: "Timeline", content: <Timeline entity="company" recordId={company.id} /> },
        ]}
        aside={
          <>
            <Section title="Tags">
              <TagPicker entity="company" recordId={company.id} current={company.tags} disabled={!canEdit} />
            </Section>
            {hasDetails ? (
              <Disclosure title="Details" bordered defaultOpen>
                <div className="flex flex-col gap-3">
                  <Facts
                    items={[
                      { label: "Company size", value: company.company_size ? `${company.company_size} employees` : "" },
                      { label: "Annual revenue", value: company.annual_revenue ? formatMoney(company.annual_revenue, company.revenue_currency || baseCurrency) : "" },
                      { label: "Source", value: company.source },
                      { label: "Address", value: formatAddress(company.address) },
                    ]}
                  />
                  {definitions.length > 0 ? <CustomFieldsSummary definitions={definitions} value={company.custom_data} /> : null}
                  {company.description ? <p className="whitespace-pre-wrap break-words text-sm">{company.description}</p> : null}
                </div>
              </Disclosure>
            ) : null}
            <Section title="Record">
              <dl className="grid gap-1.5 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-subtle">Created</dt>
                  <dd>{formatDateTime(company.created_at)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-subtle">Updated</dt>
                  <dd>{formatDateTime(company.updated_at)}</dd>
                </div>
                {company.lifecycle_changed_at ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-fg-subtle">Status changed</dt>
                    <dd>{formatDateTime(company.lifecycle_changed_at)}</dd>
                  </div>
                ) : null}
                {company.archived_at ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-fg-subtle">Archived</dt>
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
