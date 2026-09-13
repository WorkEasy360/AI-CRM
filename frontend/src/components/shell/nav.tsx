"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  Building2,
  Contact,
  KanbanSquare,
  LayoutDashboard,
  ListChecks,
  Lock,
  Package,
  Settings2,
  Users,
  UsersRound,
} from "lucide-react";
import type { ActiveContext } from "@/lib/api/types";
import { hasPermission } from "@/lib/session";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/contacts", label: "Contacts", icon: Contact },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/products", label: "Products", icon: Package },
  { href: "/activities", label: "Activities", icon: Activity },
  { href: "/reports", label: "Reports", icon: BarChart3 },
];

export const SETTINGS_NAV: NavItem[] = [
  { href: "/settings/organization", label: "Organization", icon: Settings2 },
  { href: "/settings/members", label: "Members", icon: Users },
  { href: "/settings/teams", label: "Teams", icon: UsersRound },
  { href: "/settings/security", label: "Security", icon: Lock },
  { href: "/settings/audit-log", label: "Audit log", icon: ListChecks, permission: "audit.view" },
];

export function SideNav({ active, onNavigate }: { active: ActiveContext; onNavigate?: () => void }) {
  const pathname = usePathname();
  const renderItem = (item: NavItem) => {
    if (item.permission && !hasPermission(active, item.permission)) return null;
    const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={current ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-sm px-3 py-2 text-sm font-medium transition-colors",
            current ? "bg-primary-soft text-primary" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
          )}
        >
          <item.icon className="size-4 shrink-0" />
          {item.label}
        </Link>
      </li>
    );
  };
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      <ul className="flex flex-col gap-0.5">{PRIMARY_NAV.map(renderItem)}</ul>
      <div>
        <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Settings</p>
        <ul className="flex flex-col gap-0.5">{SETTINGS_NAV.map(renderItem)}</ul>
      </div>
    </nav>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/dashboard" className={cn("flex items-center gap-2 font-semibold text-fg", className)} aria-label="Keel CRM home">
      <span className="flex size-7 items-center justify-center rounded-sm bg-primary text-primary-fg">
        <svg viewBox="0 0 20 20" className="size-4" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M5 3v14M5 10l8-7M5 10l8 7" />
        </svg>
      </span>
      <span className="text-md tracking-tight">Keel</span>
    </Link>
  );
}
