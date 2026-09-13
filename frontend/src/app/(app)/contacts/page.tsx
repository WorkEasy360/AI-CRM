import type { Metadata } from "next";
import { Contact } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Contacts" };

export default function ContactsPage() {
  return <ComingSoon title="Contacts" phase="Phase 2" icon={<Contact />} description="People you work with, linked to companies and deals." />;
}
