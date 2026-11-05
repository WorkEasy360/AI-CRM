import { CircleHelp, CreditCard, Headset, Settings, TrendingUp, UserRound } from "lucide-react";
import type { BadgeProps } from "@/components/ui/badge";
import type { TicketCategory, TicketPriority, TicketStatus } from "@/lib/api/helpdesk";

export const STATUS_LABELS: Record<TicketStatus, string> = { open: "Open", in_progress: "In Progress", resolved: "Resolved", closed: "Closed" };
export const PRIORITY_LABELS: Record<TicketPriority, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  technical: "Technical",
  billing: "Billing",
  account: "Account",
  support: "Support",
  sales: "Sales",
  other: "Other",
};

export const CATEGORY_ICONS: Record<TicketCategory, React.ComponentType<{ className?: string }>> = {
  technical: Settings,
  billing: CreditCard,
  account: UserRound,
  support: Headset,
  sales: TrendingUp,
  other: CircleHelp,
};

/** Open yellow, In Progress blue, Resolved green (the WorkEasy360 badges). */
export const STATUS_BADGE_CLASS: Record<TicketStatus, string> = {
  open: "border-transparent bg-[#fef3c7] text-[#92400e]",
  in_progress: "border-transparent bg-[#dbeafe] text-[#1d4ed8]",
  resolved: "border-transparent bg-[#dcfce7] text-[#15803d]",
  closed: "border-transparent bg-bg-subtle text-fg-muted",
};

/** High/Urgent red, Medium amber, Low green. */
export const PRIORITY_BADGE: Record<TicketPriority, BadgeProps["variant"]> = { low: "success", medium: "warning", high: "danger", urgent: "danger" };
