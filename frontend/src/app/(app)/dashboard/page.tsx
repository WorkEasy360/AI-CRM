import type { Metadata } from "next";
import * as React from "react";
import { DashboardPage } from "@/components/dashboard/dashboard-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Dashboard" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={4} />}>
      <DashboardPage />
    </React.Suspense>
  );
}
