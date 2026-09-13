"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarCheck, Contact, KanbanSquare, Plus, Search } from "lucide-react";
import { permittedQuickAddItems } from "@/components/shell/quick-add";
import { useQuickCreate, type QuickCreateKind } from "@/components/shell/quick-create-provider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ActiveContext } from "@/lib/api/types";
import { hasPermission } from "@/lib/session";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/contacts", label: "Contacts", icon: Contact },
  { href: "/activities", label: "Activities", icon: CalendarCheck },
] as const;

/** What the mobile "New" tab offers, in order: the quick wins on the road. */
export const MOBILE_NEW_KINDS: readonly QuickCreateKind[] = ["task", "call", "contact", "deal"];

const TAB_CLASS = "flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium leading-none";

/**
 * Bottom tab bar for phones and small tablets (hidden from `lg`). The sheet in the header keeps
 * the full navigation; this bar keeps the five things a rep reaches for one thumb away.
 */
export function MobileNav({ active, onSearch }: { active: ActiveContext; onSearch: () => void }) {
  const pathname = usePathname();
  const { open } = useQuickCreate();
  const canSearch = hasPermission(active, "search.use");
  const createItems = permittedQuickAddItems(active, MOBILE_NEW_KINDS);

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
                aria-current={current ? "page" : undefined}
                className={cn(TAB_CLASS, current ? "text-primary" : "text-fg-muted hover:text-fg")}
              >
                <tab.icon className="size-5" aria-hidden />
                <span className="truncate">{tab.label}</span>
              </Link>
            </li>
          );
        })}
        {canSearch ? (
          <li className="flex min-w-0 flex-1">
            <button type="button" onClick={onSearch} className={cn(TAB_CLASS, "text-fg-muted hover:text-fg")} aria-label="Search">
              <Search className="size-5" aria-hidden />
              <span>Search</span>
            </button>
          </li>
        ) : null}
        {createItems.length > 0 ? (
          <li className="flex min-w-0 flex-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(TAB_CLASS, "text-primary")} aria-label="New record">
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-fg">
                    <Plus className="size-4" aria-hidden />
                  </span>
                  <span>New</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-44">
                <DropdownMenuLabel>Create</DropdownMenuLabel>
                {createItems.map((item) => (
                  <DropdownMenuItem key={item.kind} onSelect={() => open(item.kind)}>
                    <item.icon />
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
