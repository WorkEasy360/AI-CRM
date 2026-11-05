import type { Metadata } from "next";
import * as React from "react";
import { HelpdeskPage } from "@/components/helpdesk/helpdesk-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Helpdesk" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={4} />}>
      <HelpdeskPage />
    </React.Suspense>
  );
}
