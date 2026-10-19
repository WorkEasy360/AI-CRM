"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { settingsNavItems } from "@/components/settings/settings-shell";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";

/** /settings opens the first section the member can act on; Security is always available. */
export function SettingsIndex() {
  const router = useRouter();
  const { data: session } = useSession();
  React.useEffect(() => {
    if (!session) return;
    const first = settingsNavItems(session.active)[0];
    router.replace(first?.href ?? "/settings/security");
  }, [session, router]);
  return <SkeletonRows rows={3} />;
}
