"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarCheck, House, KanbanSquare, Menu, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/dashboard", label: "Home", icon: House },
  { href: "/contacts", label: "Leads", icon: Users },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/activities", label: "Tasks", icon: CalendarCheck },
] as const;

const TAB_CLASS = "flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium leading-none";

/**
 * Bottom tab bar for phones and small tablets (hidden from `lg`): the four screens a rep lives in,
 * and "More" for the full navigation drawer.
 */
export function MobileNav({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="flex h-14 items-stretch">
        {TABS.map((tab) => {
          const current = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href} className="flex min-w-0 flex-1">
              <Link
                href={tab.href}
                // Full prefetch, for the same reason as the sidebar entries (see nav.tsx): it keeps a
                // tab tap from committing a loading skeleton and paying React's ~300 ms fallback throttle.
                prefetch
                aria-current={current ? "page" : undefined}
                className={cn(TAB_CLASS, current ? "font-semibold text-primary" : "text-fg-muted hover:text-fg")}
              >
                <tab.icon className="size-5" aria-hidden />
                <span className="truncate">{tab.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex min-w-0 flex-1">
          <button type="button" onClick={onMore} className={cn(TAB_CLASS, "text-fg-muted hover:text-fg")}>
            <Menu className="size-5" aria-hidden />
            <span>More</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
