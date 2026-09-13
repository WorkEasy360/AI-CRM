import type { Metadata } from "next";
import * as React from "react";
import { EmailSettingsPage } from "@/components/settings/email-settings-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Email" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={4} />}>
      <EmailSettingsPage />
    </React.Suspense>
  );
}
