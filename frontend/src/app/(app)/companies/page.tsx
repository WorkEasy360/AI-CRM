import type { Metadata } from "next";
import * as React from "react";
import { CompaniesPage } from "@/components/crm/companies/companies-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Companies" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={6} />}>
      <CompaniesPage />
    </React.Suspense>
  );
}
