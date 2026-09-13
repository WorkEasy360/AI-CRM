"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarDays, Handshake, ListTodo, Mail, MessageCircle, MessageSquare, MoreHorizontal, Phone } from "lucide-react";
import { ActivityFormDialog } from "@/components/activities/activity-form-dialog";
import { QuickNoteDialog } from "@/components/crm/quick-note-dialog";
import { EmailComposerDialog } from "@/components/messaging/email-composer-dialog";
import { WhatsAppDialog, type WhatsAppContact } from "@/components/messaging/whatsapp-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ActivityKind, Company, Contact, Deal, EntityType, NamedRef } from "@/lib/api/crm-types";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

type Open = { kind: "activity"; activity: ActivityKind; mode: "schedule" | "log" } | { kind: "note" } | { kind: "email" } | { kind: "whatsapp" } | null;

interface Action {
  key: string;
  label: string;
  icon: React.ReactNode;
  onSelect?: () => void;
  href?: string;
}

/** How many actions stay visible on narrow screens before the rest collapse into "More". */
const VISIBLE_ON_MOBILE = 2;

/**
 * Compact quick-action bar for record page headers: Call, Email, WhatsApp, Task, Meeting, Note and
 * Create deal. Actions the member lacks permission for are hidden; on mobile the tail collapses
 * into a "More" menu.
 */
export function QuickActions({ contact = null, company = null, deal = null, className }: { contact?: Contact | null; company?: Company | null; deal?: Deal | null; className?: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const [open, setOpen] = React.useState<Open>(null);

  const contactRef = contact
    ? { id: contact.id, name: contact.display_name || contact.email, email: contact.email }
    : deal?.primary_contact
      ? { id: deal.primary_contact.id, name: deal.primary_contact.name, email: deal.primary_contact.email }
      : null;
  // WhatsApp needs a phone number. On a contact page it comes from the record; on a deal page the
  // deal payload carries the primary contact's phone only when the member may view that contact.
  const whatsappContact: WhatsAppContact | null = contact?.phone
    ? { id: contact.id, name: contact.display_name || contact.phone, phone: contact.phone, whatsapp_opt_in: contact.whatsapp_opt_in }
    : deal?.primary_contact?.phone
      ? { id: deal.primary_contact.id, name: deal.primary_contact.name || deal.primary_contact.phone, phone: deal.primary_contact.phone, whatsapp_opt_in: Boolean(deal.primary_contact.whatsapp_opt_in) }
      : null;
  const companyRef: NamedRef | null = company ? { id: company.id, name: company.name } : (contact?.company ?? deal?.company ?? null);
  const dealRef: NamedRef | null = deal ? { id: deal.id, name: deal.name } : null;
  const primary: { entity: EntityType; id: string } | null = deal ? { entity: "deal", id: deal.id } : contact ? { entity: "contact", id: contact.id } : company ? { entity: "company", id: company.id } : null;

  const actions: Action[] = [];
  const activityDefaults = { contact: contactRef ? { id: contactRef.id, name: contactRef.name } : null, company: companyRef, deal: dealRef };
  if (can(active, "activities.create")) actions.push({ key: "call", label: "Call", icon: <Phone />, onSelect: () => setOpen({ kind: "activity", activity: "call", mode: "log" }) });
  if (can(active, "email.send") && contactRef) actions.push({ key: "email", label: "Email", icon: <Mail />, onSelect: () => setOpen({ kind: "email" }) });
  if (can(active, "whatsapp.send") && whatsappContact) actions.push({ key: "whatsapp", label: "WhatsApp", icon: <MessageCircle />, onSelect: () => setOpen({ kind: "whatsapp" }) });
  if (can(active, "activities.create")) {
    actions.push({ key: "task", label: "Task", icon: <ListTodo />, onSelect: () => setOpen({ kind: "activity", activity: "task", mode: "schedule" }) });
    actions.push({ key: "meeting", label: "Meeting", icon: <CalendarDays />, onSelect: () => setOpen({ kind: "activity", activity: "meeting", mode: "schedule" }) });
  }
  if (can(active, "notes.create") && primary) actions.push({ key: "note", label: "Note", icon: <MessageSquare />, onSelect: () => setOpen({ kind: "note" }) });
  if (can(active, "deals.create") && (contact || company)) {
    const qs = new URLSearchParams({ new: "1" });
    if (companyRef) qs.set("company", companyRef.id);
    if (contact) qs.set("contact", contact.id);
    actions.push({ key: "deal", label: "Deal", icon: <Handshake />, href: `/pipeline?${qs.toString()}` });
  }
  if (actions.length === 0) return null;

  const overflow = actions.slice(VISIBLE_ON_MOBILE);

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} role="group" aria-label="Quick actions">
      {actions.map((a, i) => {
        const hideOnMobile = i >= VISIBLE_ON_MOBILE;
        const cls = cn(hideOnMobile && "hidden sm:inline-flex");
        return a.href ? (
          <Button key={a.key} asChild size="sm" variant="secondary" className={cls}>
            <Link href={a.href}>
              {a.icon} {a.label}
            </Link>
          </Button>
        ) : (
          <Button key={a.key} size="sm" variant="secondary" className={cls} onClick={a.onSelect}>
            {a.icon} {a.label}
          </Button>
        );
      })}
      {overflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="secondary" className="sm:hidden" aria-label="More actions">
              <MoreHorizontal /> More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflow.map((a) =>
              a.href ? (
                <DropdownMenuItem key={a.key} asChild>
                  <Link href={a.href}>
                    {a.icon} {a.label}
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={a.key} onSelect={a.onSelect}>
                  {a.icon} {a.label}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {open?.kind === "activity" ? (
        <ActivityFormDialog open onOpenChange={(o) => !o && setOpen(null)} kind={open.activity} mode={open.mode} defaults={activityDefaults} />
      ) : null}
      {open?.kind === "note" && primary ? <QuickNoteDialog open onOpenChange={(o) => !o && setOpen(null)} entity={primary.entity} recordId={primary.id} /> : null}
      {open?.kind === "email" ? <EmailComposerDialog open onOpenChange={(o) => !o && setOpen(null)} contact={contactRef} deal={dealRef} company={companyRef} /> : null}
      {open?.kind === "whatsapp" && whatsappContact ? <WhatsAppDialog open onOpenChange={(o) => !o && setOpen(null)} contact={whatsappContact} deal={dealRef} /> : null}
    </div>
  );
}
