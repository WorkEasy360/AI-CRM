"use client";

import * as React from "react";
import { AuthGate, GateSkeleton } from "@/components/auth-gate";
import { AppShell } from "@/components/shell/app-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense fallback={<GateSkeleton />}>
      <AuthGate>
        {(session) =>
          session.active ? (
            <AppShell session={session} active={session.active}>
              {children}
            </AppShell>
          ) : (
            <GateSkeleton />
          )
        }
      </AuthGate>
    </React.Suspense>
  );
}
