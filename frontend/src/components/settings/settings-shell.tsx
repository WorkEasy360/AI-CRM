"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { visibleSettingsNav } from "@/components/shell/nav";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * Settings live behind the gear icon with their own left navigation. Entries are filtered by the
 * member's permissions purely for tidiness; every page and API call is still authorized server-side.
 */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const items = visibleSettingsNav(session?.active);
  const current = items.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <div className="mx-auto flex max-w-6xl gap-6">
      <nav aria-label="Settings" className="hidden w-44 shrink-0 lg:block">
        <Link href="/pipeline" className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-fg">
          <ArrowLeft className="size-3.5" aria-hidden /> Back to CRM
        </Link>
        <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Settings</p>
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const active = current?.href === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-sm px-2 text-sm font-medium transition-colors",
                    active ? "bg-primary-soft text-primary" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                  )}
                >
                  <item.icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center gap-2 lg:hidden">
          <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-fg">
            <ArrowLeft className="size-3.5" aria-hidden /> CRM
          </Link>
          <Select value={current?.href ?? ""} onValueChange={(href) => router.push(href)}>
            <SelectTrigger className="w-52" aria-label="Settings section">
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
