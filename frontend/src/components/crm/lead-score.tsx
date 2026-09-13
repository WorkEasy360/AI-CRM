"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { getContactScore } from "@/lib/api/crm";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";

export function scoreTone(value: number): "success" | "warning" | "neutral" {
  if (value >= 70) return "success";
  if (value >= 40) return "warning";
  return "neutral";
}

const TONE_CLASSES = {
  success: "border-transparent bg-success-soft text-success",
  warning: "border-transparent bg-warning-soft text-warning",
  neutral: "border-border bg-bg-subtle text-fg-muted",
} as const;

/**
 * Lead score chip (0-100). Opening it loads the reasons behind the score from the API; the popover
 * is labelled "Rules-based score" so nobody mistakes it for a prediction.
 */
export function LeadScore({ contactId, value, className }: { contactId: string; value: number; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const score = useQuery({
    queryKey: crmKeys.contactScore(contactId),
    queryFn: () => getContactScore(contactId),
    enabled: open,
    staleTime: 60_000,
  });
  const tone = scoreTone(value);
  const label = score.data?.label ?? "Rules-based score";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium tabular-nums transition-opacity hover:opacity-80",
            "focus-visible:outline-2 focus-visible:outline-ring/40",
            TONE_CLASSES[tone],
            className,
          )}
          aria-label={`Lead score ${value} out of 100. Show why`}
        >
          <Gauge className="size-3.5" aria-hidden />
          {value}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</span>
          <span className="text-sm font-semibold tabular-nums">{value}/100</span>
        </div>
        <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle" aria-hidden>
          <div
            className={cn("h-full rounded-full", tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-fg-subtle")}
            style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
          />
        </div>
        {score.isPending ? (
          <div className="flex flex-col gap-1.5" role="status" aria-label="Loading">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ) : score.isError ? (
          <p className="text-xs text-fg-muted">Could not load the reasons right now.</p>
        ) : score.data.reasons.length === 0 ? (
          <p className="text-xs text-fg-muted">Nothing has moved this score yet. Log activities and link deals to raise it.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-fg">
            {score.data.reasons.map((reason) => (
              <li key={reason} className="flex gap-1.5">
                <span className="text-fg-subtle" aria-hidden>
                  •
                </span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
