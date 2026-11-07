import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "border-border bg-bg-subtle text-fg-muted",
        primary: "border-transparent bg-primary-soft text-primary",
        accent: "border-transparent bg-accent-soft text-accent",
        success: "border-transparent bg-success-soft text-success",
        warning: "border-transparent bg-warning-soft text-warning",
        danger: "border-transparent bg-danger-soft text-danger",
        outline: "border-border-strong text-fg",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

/**
 * Marks a feature that is shown but not usable yet: a quiet grey pill, never a colour that reads as a
 * status. Pair it with a disabled control (or no link) so the feature cannot be mistaken for working.
 */
export function UpcomingBadge({ className }: { className?: string }) {
  return (
    <span className={cn(badgeVariants({ variant: "neutral" }), "px-1.5 py-0 text-[12px] font-semibold uppercase tracking-wide", className)}>
      Upcoming
    </span>
  );
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Colour a role key consistently across the app. */
export function roleBadgeVariant(role: string): BadgeProps["variant"] {
  switch (role) {
    case "owner":
      return "primary";
    case "admin":
      return "accent";
    case "sales_manager":
      return "success";
    case "sales_rep":
      return "neutral";
    case "viewer":
      return "outline";
    default:
      return "neutral";
  }
}
