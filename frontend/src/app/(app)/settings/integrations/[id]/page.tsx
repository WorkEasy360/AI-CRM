import type { Metadata } from "next";
import * as React from "react";
import { ConnectionDetailPage } from "@/components/settings/integrations/connection-detail-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Integration" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <React.Suspense fallback={<SkeletonRows rows={5} />}>
      <ConnectionDetailPage id={id} />
    </React.Suspense>
  );
}
