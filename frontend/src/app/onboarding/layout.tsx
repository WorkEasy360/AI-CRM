"use client";

import * as React from "react";
import { AuthGate } from "@/components/auth-gate";
import { Skeleton } from "@/components/ui/skeleton";

function OnboardingSkeleton() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6" role="status" aria-label="Loading">
      <Skeleton className="h-80 w-full max-w-lg" />
    </div>
  );
}

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense fallback={<OnboardingSkeleton />}>
      <AuthGate requireOrganization={false} fallback={<OnboardingSkeleton />}>
        {() => <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">{children}</div>}
      </AuthGate>
    </React.Suspense>
  );
}
