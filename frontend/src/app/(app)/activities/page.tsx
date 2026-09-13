import type { Metadata } from "next";
import * as React from "react";
import { ActivitiesPage } from "@/components/activities/activities-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Activities" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={4} />}>
      <ActivitiesPage />
    </React.Suspense>
  );
}
