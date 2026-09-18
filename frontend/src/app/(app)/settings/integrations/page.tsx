import type { Metadata } from "next";
import * as React from "react";
import { IntegrationsPage } from "@/components/settings/integrations/integrations-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Integrations" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={4} />}>
      <IntegrationsPage />
    </React.Suspense>
  );
}
