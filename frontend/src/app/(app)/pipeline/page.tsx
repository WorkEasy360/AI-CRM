import * as React from "react";
import type { Metadata } from "next";
import { PipelinePage } from "@/components/crm/pipeline/pipeline-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Pipeline" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={4} />}>
      <PipelinePage />
    </React.Suspense>
  );
}
