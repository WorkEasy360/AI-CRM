import type { Metadata } from "next";
import * as React from "react";
import { ForecastPage } from "@/components/forecast/forecast-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Forecast" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={4} />}>
      <ForecastPage />
    </React.Suspense>
  );
}
