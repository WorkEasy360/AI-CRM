import * as React from "react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export function ComingSoon({
  title,
  description,
  phase,
  icon,
}: {
  title: string;
  description: string;
  phase: "Phase 2" | "Phase 3";
  icon: React.ReactNode;
}) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={icon}
        title={`Coming in ${phase}`}
        description={`${title} is on the roadmap. Phase 1 covers accounts, organisations, members, teams and security.`}
      />
    </div>
  );
}
