import type { Metadata } from "next";
import * as React from "react";
import { ContactsPage } from "@/components/crm/contacts/contacts-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Contacts" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={6} />}>
      <ContactsPage />
    </React.Suspense>
  );
}
