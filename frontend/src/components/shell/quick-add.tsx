"use client";

import { Building2, CalendarDays, ChevronDown, Contact, Handshake, ListTodo, Phone, Plus } from "lucide-react";
import { useQuickCreate, type QuickCreateKind } from "@/components/shell/quick-create-provider";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ActiveContext } from "@/lib/api/types";
import { hasPermission } from "@/lib/session";

export interface QuickAddItem {
  kind: QuickCreateKind;
  label: string;
  permission: string;
  icon: React.ComponentType<{ className?: string }>;
}

/** Everything the header "+ New" menu can create, in display order. Records first, then activities. */
export const QUICK_ADD_ITEMS: readonly QuickAddItem[] = [
  { kind: "contact", label: "Contact", permission: "contacts.create", icon: Contact },
  { kind: "company", label: "Company", permission: "companies.create", icon: Building2 },
  { kind: "deal", label: "Deal", permission: "deals.create", icon: Handshake },
  { kind: "task", label: "Task", permission: "activities.create", icon: ListTodo },
  { kind: "call", label: "Call", permission: "activities.create", icon: Phone },
  { kind: "meeting", label: "Meeting", permission: "activities.create", icon: CalendarDays },
];

const RECORD_KINDS: readonly QuickCreateKind[] = ["contact", "company", "deal"];

/** The items the member may create, optionally restricted to (and ordered by) `kinds`. */
export function permittedQuickAddItems(active: ActiveContext | null | undefined, kinds?: readonly QuickCreateKind[]): QuickAddItem[] {
  const items = QUICK_ADD_ITEMS.filter((item) => hasPermission(active, item.permission));
  if (!kinds) return items;
  return kinds.flatMap((kind) => items.filter((item) => item.kind === kind));
}

/** The header "+ New" dropdown. Renders nothing when the member may not create any record type. */
export function QuickAdd({ active }: { active: ActiveContext }) {
  const { open } = useQuickCreate();
  const items = permittedQuickAddItems(active);
  const records = items.filter((item) => RECORD_KINDS.includes(item.kind));
  const activities = items.filter((item) => !RECORD_KINDS.includes(item.kind));
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="px-2 sm:px-2.5" aria-label="New record">
          <Plus />
          <span className="hidden sm:inline">New</span>
          <ChevronDown className="hidden opacity-70 sm:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Create</DropdownMenuLabel>
        {records.map((item) => (
          <DropdownMenuItem key={item.kind} onSelect={() => open(item.kind)}>
            <item.icon />
            {item.label}
          </DropdownMenuItem>
        ))}
        {records.length > 0 && activities.length > 0 ? <DropdownMenuSeparator /> : null}
        {activities.map((item) => (
          <DropdownMenuItem key={item.kind} onSelect={() => open(item.kind)}>
            <item.icon />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
