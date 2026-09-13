import type { Metadata } from "next";
import { ContactDetailPage } from "@/components/crm/contacts/contact-detail-page";

export const metadata: Metadata = { title: "Contact" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactDetailPage id={id} />;
}
