"use client";

import * as React from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, Building2, ChevronRight, Globe, Mail, MapPin, MoreHorizontal, Pencil, Phone, UserRound } from "lucide-react";
import { LeadScore } from "@/components/crm/lead-score";
import { LifecycleStatusChanger } from "@/components/crm/lifecycle-select";
import { QuickActions } from "@/components/crm/quick-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Contact } from "@/lib/api/crm-types";
import { initials } from "@/lib/utils";

const enc = encodeURIComponent;

/** "Contacts › Contact Details" with the record's Edit and More actions on the right. */
export function ContactToolbar({
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
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-1 text-sm">
          <li>
            <Link href="/contacts" className="text-fg-muted hover:text-primary hover:underline">
              Contacts
            </Link>
          </li>
          <li aria-hidden>
            <ChevronRight className="size-3.5 text-fg-subtle" />
          </li>
          <li aria-current="page" className="font-medium text-fg">
            Contact Details
          </li>
        </ol>
      </nav>
      <div className="flex shrink-0 items-center gap-2">
        {canEdit ? (
          <Button size="sm" onClick={onEdit}>
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
  );
}

function Fact({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 items-start gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <span className="sr-only">{label}: </span>
      <span className="min-w-0 break-words text-sm text-fg">{children}</span>
    </li>
  );
}

/** The left-hand card of the 360° view: who this is, how to reach them, and where they came from. */
export function ContactProfileCard({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const title = contact.display_name || contact.email || "Unnamed contact";
  const place = [contact.address?.city, contact.address?.country].filter(Boolean).join(", ");
  return (
    <section aria-label="Contact profile" className="rounded-lg border border-border bg-surface p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-brand text-lg font-bold text-brand-fg" aria-hidden>
          {initials(title)}
        </span>
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-bold leading-tight tracking-tight text-fg">{title}</h1>
          {contact.job_title || contact.company ? (
            <p className="mt-0.5 text-sm text-fg-muted">
              {contact.job_title}
              {contact.job_title && contact.company ? " · " : null}
              {contact.company ? contact.company.name : null}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <LifecycleStatusChanger entity="contact" record={contact} disabled={!canEdit} />
            <LeadScore contactId={contact.id} value={contact.lead_score} />
            {contact.archived_at ? <Badge variant="warning">Archived</Badge> : null}
          </div>
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-2.5 border-t border-border pt-4">
        {contact.phone ? (
          <Fact icon={Phone} label="Phone">
            <a href={`tel:${contact.phone}`} className="hover:text-primary hover:underline">
              {contact.phone}
            </a>
          </Fact>
        ) : null}
        {contact.email ? (
          <Fact icon={Mail} label="Email">
            <a href={`mailto:${contact.email}`} className="hover:text-primary hover:underline">
              {contact.email}
            </a>
          </Fact>
        ) : null}
        {place ? (
          <Fact icon={MapPin} label="Location">
            {place}
          </Fact>
        ) : null}
        {contact.company ? (
          <Fact icon={Building2} label="Company">
            <Link href={`/companies/${enc(contact.company.id)}`} className="text-primary hover:underline">
              {contact.company.name}
            </Link>
          </Fact>
        ) : null}
        {contact.source ? (
          <Fact icon={Globe} label="Source">
            Source: {contact.source}
          </Fact>
        ) : null}
        <Fact icon={UserRound} label="Owner">
          Owner: {contact.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span>}
        </Fact>
      </ul>

      <QuickActions contact={contact} className="mt-4" />
    </section>
  );
}
