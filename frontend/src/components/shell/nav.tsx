"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Building2,
  CalendarCheck,
  Contact,
  DatabaseZap,
  KanbanSquare,
  LayoutDashboard,
  ListChecks,
  Lock,
  Mail,
  MessageCircle,
  Package,
  PlugZap,
  Settings,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import type { ActiveContext, Session } from "@/lib/api/types";
import { hasPermission } from "@/lib/session";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

/** The everyday CRM. Six entries, nothing administrative. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  { href: "/contacts", label: "Contacts", icon: Contact },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/activities", label: "Activities", icon: CalendarCheck },
  { href: "/products", label: "Products", icon: Package },
];

export interface SettingsNavItem extends NavItem {
  /** UI-only visibility rule. The API enforces the real permission on every request. */
  visible: (active: ActiveContext | null | undefined) => boolean;
  /** Other routes that belong to this entry (highlighted as current). */
  also?: readonly string[];
}

const anyOf = (active: ActiveContext | null | undefined, keys: string[]) => keys.some((key) => hasPermission(active, key));

/** Administrative pages, reachable from the gear icon only, shown when the member can act on them. */
export const SETTINGS_NAV: readonly SettingsNavItem[] = [
  { href: "/settings/general", label: "General", icon: Settings2, visible: (a) => hasPermission(a, "org.update") },
  {
    href: "/settings/users",
    label: "Users & Teams",
    icon: Users,
    also: ["/settings/teams"],
    visible: (a) => anyOf(a, ["members.invite", "members.update_role", "members.disable", "members.remove", "teams.manage"]),
  },
  { href: "/settings/pipelines", label: "Pipelines", icon: KanbanSquare, visible: (a) => hasPermission(a, "pipelines.manage") },
  { href: "/settings/custom-fields", label: "Custom fields", icon: SlidersHorizontal, visible: (a) => hasPermission(a, "customfields.manage") },
  { href: "/settings/tags", label: "Tags", icon: Tag, visible: (a) => hasPermission(a, "tags.manage") },
  { href: "/settings/email", label: "Email", icon: Mail, visible: (a) => hasPermission(a, "email.view") },
  { href: "/settings/whatsapp", label: "WhatsApp", icon: MessageCircle, visible: (a) => hasPermission(a, "whatsapp.view") },
  { href: "/settings/notifications", label: "Notifications", icon: Bell, visible: () => true },
  { href: "/settings/ai", label: "AI", icon: Sparkles, visible: (a) => hasPermission(a, "ai.settings.manage") },
  { href: "/settings/integrations", label: "Integrations", icon: PlugZap, visible: (a) => anyOf(a, ["integrations.view", "webhooks.manage"]) },
  { href: "/settings/security", label: "Security", icon: Lock, visible: () => true },
  {
    href: "/settings/data",
    label: "Import / Export",
    icon: DatabaseZap,
    visible: (a) =>
      anyOf(a, ["contacts.import", "companies.import", "products.import", "contacts.export", "companies.export", "products.export", "deals.export"]),
  },
  { href: "/settings/audit-log", label: "Audit log", icon: ListChecks, visible: (a) => hasPermission(a, "audit.view") },
];

export function visibleSettingsNav(active: ActiveContext | null | undefined): SettingsNavItem[] {
  return SETTINGS_NAV.filter((item) => item.visible(active));
}

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The primary destinations are prefetched in full rather than with the default partial prefetch.
 *
 * Every route renders dynamically (per-request CSP nonce, see app/layout.tsx), so a default
 * `<Link>` prefetch stops at the `loading.tsx` boundary and leaves the page's own client chunk to be
 * downloaded on click. React then had to commit that loading skeleton, and committing a Suspense
 * fallback starts React's fallback throttle: once a fallback is on screen it will not be replaced for
 * ~300 ms, even though the chunk had in fact arrived ~60 ms in. Measured on a production build, every
 * sidebar click paid it — the skeleton painted at ~40-80 ms, the route's JS finished at ~60-100 ms,
 * and the real page appeared only at ~350-405 ms with the main thread completely idle in between.
 *
 * A full prefetch warms the route payload *and* its client chunk, so the click renders the page
 * without ever suspending and the throttle never starts. `loading.tsx` stays as the safety net for
 * a cold or slow connection where the prefetch has not landed.
 *
 * Only these always-visible entries are prefetched. Record rows keep `prefetch={false}` (see
 * data-table.tsx): there are hundreds of them and they are not a fixed, small set.
 */
const PREFETCH_PRIMARY = true;

export function SideNav({ session, onNavigate }: { session: Session; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = session.active;
  const name = session.user.display_name || session.user.email;
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col overflow-y-auto">
      <ul className="flex flex-col gap-0.5 px-2 py-2">
        {PRIMARY_NAV.map((item) => {
          const current = isCurrent(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={PREFETCH_PRIMARY}
                onClick={onNavigate}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-sm font-medium transition-colors",
                  current ? "bg-primary-soft text-primary" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                )}
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto border-t border-border px-2 py-2">
        <Link
          href="/settings"
          prefetch={PREFETCH_PRIMARY}
          onClick={onNavigate}
          aria-current={isCurrent(pathname, "/settings") ? "page" : undefined}
          className={cn(
            "flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-sm font-medium transition-colors",
            isCurrent(pathname, "/settings") ? "bg-primary-soft text-primary" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
          )}
        >
          <Settings className="size-4 shrink-0" />
          Settings
        </Link>
        <Link
          href="/settings/security"
          onClick={onNavigate}
          className="mt-1 flex items-center gap-2.5 rounded-sm px-2 py-1.5 hover:bg-bg-subtle"
          aria-label={`${name}: profile and security`}
        >
          <Avatar name={name} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-fg">{name}</span>
            <span className="block truncate text-xs text-fg-subtle">{active?.role.name ?? session.user.email}</span>
          </span>
        </Link>
      </div>
    </nav>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/pipeline" className={cn("flex items-center gap-2 font-semibold text-fg", className)} aria-label="Keel CRM home">
      <span className="flex size-6 items-center justify-center rounded-sm bg-primary text-primary-fg">
        <svg viewBox="0 0 20 20" className="size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M5 3v14M5 10l8-7M5 10l8 7" />
        </svg>
      </span>
      <span className="text-sm tracking-tight">Keel</span>
    </Link>
  );
}
