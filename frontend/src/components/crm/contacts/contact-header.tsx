"use client";

import Link from "next/link";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil } from "lucide-react";
import { KeyFacts } from "@/components/crm/contacts/record-layout";
import { LeadScore } from "@/components/crm/lead-score";
import { LifecycleStatusChanger } from "@/components/crm/lifecycle-select";
import { QuickActions } from "@/components/crm/quick-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Contact } from "@/lib/api/crm-types";

const enc = encodeURIComponent;

/** Contact page header: name, company, job title, key facts (phone, email, owner, status, score) and quick actions. */
export function ContactHeader({
  contact,
  canEdit,
  canDelete,
  onEdit,
  onArchive,
  onRestore,
}: {
  contact: Contact;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const title = contact.display_name || contact.email || "Unnamed contact";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
            {contact.archived_at ? <Badge variant="warning">Archived</Badge> : null}
          </div>
          {contact.company || contact.job_title ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-fg-muted">
              {contact.job_title ? <span>{contact.job_title}</span> : null}
              {contact.job_title && contact.company ? <span aria-hidden>·</span> : null}
              {contact.company ? (
                <Link href={`/companies/${enc(contact.company.id)}`} className="text-primary hover:underline">
                  {contact.company.name}
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canEdit ? (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              <Pencil /> Edit
            </Button>
          ) : null}
          {canDelete ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {contact.archived_at ? (
                  <DropdownMenuItem onSelect={onRestore}>
                    <ArchiveRestore /> Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem destructive onSelect={onArchive}>
                    <Archive /> Archive
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <KeyFacts
        items={[
          { label: "Phone", value: contact.phone ? <a href={`tel:${contact.phone}`} className="hover:text-primary hover:underline">{contact.phone}</a> : "" },
          { label: "Email", value: contact.email ? <a href={`mailto:${contact.email}`} className="hover:text-primary hover:underline">{contact.email}</a> : "" },
          { label: "Owner", value: contact.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span> },
          { label: "Status", value: <LifecycleStatusChanger entity="contact" record={contact} disabled={!canEdit} /> },
          { label: "Score", value: <LeadScore contactId={contact.id} value={contact.lead_score} /> },
        ]}
      />

      <QuickActions contact={contact} />
    </div>
  );
}
