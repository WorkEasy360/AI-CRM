import type { RiskLevel } from "@/lib/api/crm-types";
import { cn } from "@/lib/utils";

export const RISK_LABELS: Record<RiskLevel, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

const DOT: Record<RiskLevel, string> = { low: "bg-success", medium: "bg-warning", high: "bg-danger" };
const PILL: Record<RiskLevel, string> = {
  low: "border-transparent bg-success-soft text-success",
  medium: "border-transparent bg-warning-soft text-warning",
  high: "border-transparent bg-danger-soft text-danger",
};

/**
 * Rules-based deal risk. The full variant is a coloured pill ("High risk"); `compact` renders a
 * coloured dot for dense surfaces (board cards, table cells) with the label in `aria-label`.
 * `reason` becomes the tooltip so the level is never shown without a way to see why.
 */
export function RiskBadge({ level, compact = false, reason, className }: { level: RiskLevel; compact?: boolean; reason?: string; className?: string }) {
  const label = RISK_LABELS[level] ?? "Unknown risk";
  const tooltip = reason ? `${label}: ${reason}` : label;
  if (compact) {
    return <span role="img" aria-label={tooltip} title={tooltip} className={cn("inline-block size-2 shrink-0 rounded-full", DOT[level], className)} data-risk={level} />;
  }
  return (
    <span
      title={tooltip}
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", PILL[level], className)}
      data-risk={level}
    >
      <span className={cn("size-1.5 rounded-full", DOT[level])} aria-hidden />
      {label}
    </span>
  );
}
