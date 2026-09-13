"use client";

import { useQuery } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { EmailHistory } from "@/components/messaging/email-history";
import { WhatsAppConversation } from "@/components/messaging/whatsapp-conversation";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { getContact } from "@/lib/api/crm";
import type { Deal } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";

/**
 * Email history for the deal plus the WhatsApp conversation with its primary contact. The deal only
 * carries id/name/email for the contact, so the full contact (phone, opt-in) is loaded on demand.
 */
export function DealCommunication({ deal }: { deal: Deal }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canViewEmail = can(active, "email.view");
  const canViewWhatsApp = can(active, "whatsapp.view");
  const contactId = deal.primary_contact?.id;
  const contact = useQuery({
    queryKey: crmKeys.record("contacts", contactId ?? ""),
    queryFn: () => getContact(contactId ?? ""),
    enabled: canViewWhatsApp && Boolean(contactId),
    staleTime: 60_000,
  });

  const contactRef = deal.primary_contact ? { id: deal.primary_contact.id, name: deal.primary_contact.name, email: deal.primary_contact.email } : null;
  const dealRef = { id: deal.id, name: deal.name };

  if (!canViewEmail && !canViewWhatsApp) {
    return <EmptyState title="Communication is not available to you" description="Ask an administrator for access to email or WhatsApp history." className="py-8" />;
  }

  return (
    <div className="flex flex-col gap-6">
      {canViewEmail ? <EmailHistory entity="deal" recordId={deal.id} contact={contactRef} deal={dealRef} company={deal.company} /> : null}
      {canViewWhatsApp ? (
        !contactId ? (
          <p className="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-3 text-sm text-fg-muted">
            <MessageCircle className="size-4 shrink-0" aria-hidden />
            Set a primary contact on this deal to see and send WhatsApp messages.
          </p>
        ) : contact.isPending ? (
          <SkeletonRows rows={2} />
        ) : contact.isError ? (
          <p className="text-sm text-fg-muted">The primary contact could not be loaded, so WhatsApp messages are not shown here.</p>
        ) : (
          <WhatsAppConversation
            contact={{ id: contact.data.id, name: contact.data.display_name || contact.data.email, phone: contact.data.phone, whatsapp_opt_in: contact.data.whatsapp_opt_in }}
            deal={dealRef}
          />
        )
      ) : null}
    </div>
  );
}
