import { Badge, type BadgeProps } from "@/components/ui/badge";
import { LIFECYCLE_LABELS, type LifecycleStage } from "@/lib/api/crm-types";

/** Badge variant per lifecycle stage: lead slate, prospect blue, qualified amber, customer green, inactive red. */
export function lifecycleVariant(stage: LifecycleStage | string | null | undefined): BadgeProps["variant"] {
  switch (stage) {
    case "prospect":
      return "primary";
    case "qualified":
      return "warning";
    case "customer":
      return "success";
    case "inactive":
      return "danger";
    default:
      return "neutral";
  }
}

export function lifecycleLabel(stage: LifecycleStage | string | null | undefined): string {
  return (stage && LIFECYCLE_LABELS[stage as LifecycleStage]) || "Lead";
}

/** Compact status pill shown in tables and record headers. */
export function LifecycleBadge({ stage, className }: { stage: LifecycleStage | string | null | undefined; className?: string }) {
  return (
    <Badge variant={lifecycleVariant(stage)} className={className}>
      {lifecycleLabel(stage)}
    </Badge>
  );
}
