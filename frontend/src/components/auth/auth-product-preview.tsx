import * as React from "react";
import { BarChart3, KanbanSquare, LayoutDashboard, ListChecks, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [LayoutDashboard, Users, KanbanSquare, ListChecks, BarChart3] as const;
const BARS = [24, 40, 56, 72, 100];

/**
 * The laptop on the sign-in panel: a drawn sketch of the app's layout, not a screenshot. It carries no
 * figures on purpose, because a sign-in page should never show numbers that look like someone's data.
 * Decorative, so hidden from assistive technology.
 */
export function AuthProductPreview({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden>
      <div className="rounded-t-xl border-[6px] border-b-0 border-chrome-raised bg-chrome-raised shadow-lg">
        <div className="flex aspect-[16/10] overflow-hidden rounded-t-md bg-[var(--kl-slate-50)]">
          <div className="flex w-1/5 flex-col gap-2 bg-chrome p-2">
            <span className="mb-1 h-2 w-3/4 rounded-full bg-chrome-indicator" />
            {NAV.map((Icon, i) => (
              <span key={i} className={cn("flex items-center gap-1.5 rounded-sm p-1", i === 0 && "bg-chrome-active")}>
                <Icon className="size-3 shrink-0 text-white/80" />
                <span className="h-1 flex-1 rounded-full bg-white/30" />
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2 p-2.5">
            <div className="grid grid-cols-4 gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="flex flex-col gap-1 rounded-sm bg-white p-1.5 shadow-sm">
                  <span className="h-1 w-3/4 rounded-full bg-[var(--kl-slate-200)]" />
                  <span className="h-2 w-1/2 rounded-full bg-[var(--kl-slate-400)]" />
                </span>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[3fr_2fr] gap-1.5">
              <span className="flex items-end gap-1.5 rounded-sm bg-white p-2 shadow-sm">
                {BARS.map((height) => (
                  <span key={height} className="flex-1 rounded-t-sm bg-[var(--kl-brand-bright)]" style={{ height: `${height}%` }} />
                ))}
              </span>
              <span className="flex items-center justify-center rounded-sm bg-white p-2 shadow-sm">
                <span className="aspect-square h-3/4 rounded-full border-[7px] border-[var(--kl-brand-bright)] border-r-[var(--kl-slate-300)]" />
              </span>
            </div>
            <div className="grid grid-cols-[3fr_2fr] gap-1.5">
              <span className="flex flex-col gap-1.5 rounded-sm bg-white p-2 shadow-sm">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="h-1 rounded-full bg-[var(--kl-slate-200)]" />
                ))}
              </span>
              <span className="flex flex-col gap-1.5 rounded-sm bg-white p-2 shadow-sm">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="h-1 rounded-full bg-[var(--kl-brand-soft)]" />
                ))}
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="-mx-[6%] h-2.5 rounded-b-xl bg-[var(--kl-slate-300)] shadow-md" />
    </div>
  );
}
