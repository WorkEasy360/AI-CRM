"use client";

import { FileText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmailTemplatesSection } from "@/components/settings/email-templates-section";
import { WhatsAppTemplatesSection } from "@/components/settings/whatsapp-templates-section";
import { EmptyState } from "@/components/ui/empty-state";
import { hasPermission, useSession } from "@/lib/session";

/** Email and WhatsApp templates in one place; each section keeps its own permission. */
export function MessageTemplatesPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  if (!session) return null;
  const email = hasPermission(active, "email.view");
  const whatsapp = hasPermission(active, "whatsapp.view");
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader title="Message Templates" description="Reusable email templates and approved WhatsApp templates for follow-ups and automations." />
      {!email && !whatsapp ? <EmptyState icon={<FileText />} title="Templates are not part of your role" description="Ask a workspace administrator for access." /> : null}
      {email ? <EmailTemplatesSection canManage={hasPermission(active, "email.templates_manage")} /> : null}
      {whatsapp ? <WhatsAppTemplatesSection canManage={hasPermission(active, "whatsapp.manage")} /> : null}
    </div>
  );
}
