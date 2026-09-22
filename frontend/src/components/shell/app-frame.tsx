"use client";

import * as React from "react";
import { AuthGate, GateSkeleton } from "@/components/auth-gate";
import { AppShell } from "@/components/shell/app-shell";

/**
 * The client half of the `(app)` layout: resolve the session, then keep one shell mounted around
 * every route in the group. Split out of layout.tsx so the layout itself can stay a Server Component
 * and read the CSP nonce for the session preload.
 */
export function AppFrame({ children }: { children: React.ReactNode }) {
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
