import * as React from "react";
import type { Metadata } from "next";
import { AcceptInvitation } from "@/components/auth/accept-invitation";

export const metadata: Metadata = { title: "Accept invitation" };

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <AcceptInvitation />
    </React.Suspense>
  );
}
