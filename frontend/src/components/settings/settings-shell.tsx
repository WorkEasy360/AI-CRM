"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { visibleSettingsNav, type SettingsGroup, type SettingsNavItem } from "@/components/shell/nav";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ActiveContext } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

export function settingsNavItems(active: ActiveContext | null | undefined): SettingsNavItem[] {
  return visibleSettingsNav(active);
}

/** Consecutive entries under their group heading, keeping the SETTINGS_NAV order. */
function grouped(items: SettingsNavItem[]): { group: SettingsGroup; items: SettingsNavItem[] }[] {
  const out: { group: SettingsGroup; items: SettingsNavItem[] }[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.group === item.group) last.items.push(item);
    else out.push({ group: item.group, items: [item] });
  }
  return out;
}

/**
 * Settings live behind the gear icon with their own left navigation, and the page takes the rest of
 * the width. Entries are filtered by the member's permissions purely for tidiness; every page and API
 * call is still authorized server-side.
 */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const items = settingsNavItems(session?.active);
  const matches = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const current = items.find((item) => matches(item.href) || (item.also ?? []).some(matches));

  // The Settings home is its own full-width card grid; the section navigation starts one level down.
  if (pathname === "/settings") return <div className="w-full">{children}</div>;

  return (
    <div className="flex w-full gap-6">
      <nav aria-label="Settings" className="hidden w-60 shrink-0 xl:block">
        {/* Sticky inside the scrolling <main>, so the section list stays put on long pages. */}
        <div className="sticky top-0 flex max-h-[calc(100dvh-7.5rem)] flex-col overflow-y-auto rounded-lg border border-border bg-surface p-2 shadow-sm">
          <Link href="/pipeline" className="mb-1 inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-sm font-medium text-fg-muted hover:bg-bg-subtle hover:text-fg">
            <ArrowLeft className="size-4" aria-hidden /> Back to CRM
          </Link>
          {grouped(items).map((section) => (
            <div key={section.group} className="border-t border-border pt-2 pb-1 first-of-type:border-t-0">
              <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{section.group}</p>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const active = current?.href === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex h-9 items-center gap-2.5 rounded-sm px-2.5 text-sm font-medium transition-colors",
                          active
                            ? "bg-primary-soft text-primary shadow-[inset_3px_0_0_var(--kl-brand-bright)]"
                            : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                        )}
                      >
                        <item.icon className="size-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className="min-w-0 flex-1">
        <div className="mb-4 flex items-center gap-2 xl:hidden">
          <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted hover:text-fg">
            <ArrowLeft className="size-4" aria-hidden /> CRM
          </Link>
          <Select value={current?.href ?? ""} onValueChange={(href) => router.push(href)}>
            <SelectTrigger className="w-full max-w-64" aria-label="Settings section">
              <SelectValue placeholder="Settings" />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.href} value={item.href}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {children}
      </div>
    </div>
  );
}
