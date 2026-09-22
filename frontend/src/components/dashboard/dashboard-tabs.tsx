import * as React from "react";
import Link from "next/link";
import { LayoutDashboard, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

export type DashboardTab = "overview" | "forecast";

const TABS: { key: DashboardTab; href: string; label: string; icon: React.ReactNode }[] = [
  { key: "overview", href: "/dashboard", label: "Overview", icon: <LayoutDashboard /> },
  { key: "forecast", href: "/dashboard/forecast", label: "Forecast", icon: <TrendingUp /> },
];

/** Segmented Overview | Forecast switch; each segment is a real route so both views are linkable. */
export function DashboardTabs({ active }: { active: DashboardTab }) {
  return (
    <nav aria-label="Dashboard views" className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-bg-subtle p-0.5">
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            // Two always-visible segments that read as a toggle, so they have to behave like one.
            // Each is a separate dynamic route, and with the default partial prefetch the other tab's
            // chunk only started downloading on click: the loading skeleton committed first and React
            // then held it for its ~300 ms fallback throttle (measured 461 ms per switch). Prefetching
            // both in full takes the switch to the same range as the sidebar. See shell/nav.tsx.
            prefetch
            aria-current={current ? "page" : undefined}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors [&_svg]:size-3.5",
              current ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            {tab.icon}
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
