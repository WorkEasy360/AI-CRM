import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "people", href: "/contacts", label: "People (Contacts)" },
  { key: "companies", href: "/companies", label: "Companies" },
] as const;

/** People | Companies switch above the two lists; the current one is the solid green segment. */
export function ContactsTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="Contacts views" className="mb-3 inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface p-1">
      {TABS.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            // Prefetched in full so the switch never commits a loading skeleton (see shell/nav.tsx).
            prefetch
            aria-current={current ? "page" : undefined}
            className={cn(
              "inline-flex h-7 items-center rounded-sm px-3 text-sm font-medium transition-colors",
              current ? "bg-brand text-brand-fg shadow-sm" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
