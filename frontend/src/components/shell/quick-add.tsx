"use client";

import Link from "next/link";
import { Building2, ChevronDown, Contact, Handshake, Package, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ActiveContext } from "@/lib/api/types";
import { hasPermission } from "@/lib/session";

interface QuickAddItem {
  label: string;
  href: string;
  permission: string;
  icon: React.ComponentType<{ className?: string }>;
}

/** Fixed, hard-coded targets: the list pages open their create dialog when `?new=1` is present. */
export const QUICK_ADD_ITEMS: readonly QuickAddItem[] = [
  { label: "New contact", href: "/contacts?new=1", permission: "contacts.create", icon: Contact },
  { label: "New company", href: "/companies?new=1", permission: "companies.create", icon: Building2 },
  { label: "New deal", href: "/pipeline?new=1", permission: "deals.create", icon: Handshake },
  { label: "New product", href: "/products?new=1", permission: "products.create", icon: Package },
];

/** The header "New" dropdown. Renders nothing when the member may not create any record type. */
export function QuickAdd({ active }: { active: ActiveContext }) {
  const items = QUICK_ADD_ITEMS.filter((item) => hasPermission(active, item.permission));
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className="px-2 sm:px-3" aria-label="New record">
          <Plus />
          <span className="hidden sm:inline">New</span>
          <ChevronDown className="hidden text-fg-subtle sm:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Create</DropdownMenuLabel>
        {items.map((item) => (
          <DropdownMenuItem key={item.href} asChild>
            <Link href={item.href}>
              <item.icon />
              {item.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
