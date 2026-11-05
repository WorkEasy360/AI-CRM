"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  BookOpen,
  Building2,
  CalendarCheck,
  ChevronDown,
  Contact,
  CreditCard,
  DatabaseZap,
  Headset,
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
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  UserRound,
  Users,
  Workflow,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import type { ActiveContext, Session } from "@/lib/api/types";
import { hasPermission } from "@/lib/session";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** A collapsible group (Contacts: People and Companies). The first child shares the parent's route. */
  children?: readonly NavItem[];
}

/** The everyday CRM, in the WorkEasy360 order. Nothing administrative: that lives behind Settings. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare },
  {
    href: "/contacts",
    label: "Contacts",
    icon: Contact,
    children: [
      { href: "/contacts", label: "People (Contacts)", icon: UserRound },
      { href: "/companies", label: "Companies", icon: Building2 },
    ],
  },
  { href: "/activities", label: "Activities", icon: CalendarCheck },
  { href: "/assistant", label: "AI Assistant", icon: Sparkles },
  { href: "/helpdesk", label: "Helpdesk", icon: Headset },
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
  { href: "/settings/roles", label: "Roles & permissions", icon: ShieldCheck, visible: (a) => hasPermission(a, "roles.manage") },
  { href: "/settings/billing", label: "Plan & usage", icon: CreditCard, visible: (a) => anyOf(a, ["org.billing", "org.update"]) },
  { href: "/settings/automation", label: "Automation", icon: Workflow, visible: (a) => hasPermission(a, "automation.view") },
  { href: "/settings/pipelines", label: "Pipelines", icon: KanbanSquare, visible: (a) => hasPermission(a, "pipelines.manage") },
  { href: "/settings/price-books", label: "Price books", icon: BookOpen, visible: (a) => hasPermission(a, "pricebooks.manage") },
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
      anyOf(a, ["contacts.import", "companies.import", "products.import", "deals.import", "contacts.export", "companies.export", "products.export", "deals.export"]),
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

/** The sidebar sits on the green chrome: the current page is a solid green pill with white text. */
const LINK = "flex h-9 items-center gap-2.5 rounded-md px-3 text-sm font-medium transition-colors";
const ACTIVE_LINK = "bg-chrome-active text-fg shadow-sm";
const IDLE_LINK = "text-fg-muted hover:bg-bg-subtle hover:text-fg";

export function SideNav({ session, onNavigate }: { session: Session; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = session.active;
  const name = session.user.display_name || session.user.email;
  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col overflow-y-auto">
      <ul className="flex flex-col gap-1 px-2.5 py-3">
        {PRIMARY_NAV.map((item) =>
          item.children ? (
            <NavGroup key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
          ) : (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={PREFETCH_PRIMARY}
                onClick={onNavigate}
                aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                className={cn(LINK, isCurrent(pathname, item.href) ? ACTIVE_LINK : IDLE_LINK)}
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
              </Link>
            </li>
          ),
        )}
        <li>
          <Link
            href="/settings"
            prefetch={PREFETCH_PRIMARY}
            onClick={onNavigate}
            aria-current={isCurrent(pathname, "/settings") ? "page" : undefined}
            className={cn(LINK, isCurrent(pathname, "/settings") ? ACTIVE_LINK : IDLE_LINK)}
          >
            <Settings className="size-4 shrink-0" />
            Settings
          </Link>
        </li>
      </ul>

      <div className="mt-auto border-t border-border px-2.5 py-2">
        <Link
          href="/settings/security"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-bg-subtle"
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

/** Contacts and its sub-pages. The parent is the green pill whenever any page in the group is open. */
function NavGroup({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const children = item.children ?? [];
  const inGroup = children.some((child) => isCurrent(pathname, child.href));
  const [expanded, setExpanded] = React.useState(true);
  const listId = React.useId();
  return (
    <li>
      <div className={cn("flex items-center rounded-md transition-colors", inGroup ? ACTIVE_LINK : IDLE_LINK)}>
        <Link
          href={item.href}
          prefetch={PREFETCH_PRIMARY}
          onClick={onNavigate}
          className={cn(LINK, "min-w-0 flex-1 pr-1 text-inherit hover:bg-transparent")}
        >
          <item.icon className="size-4 shrink-0" />
          {item.label}
        </Link>
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${item.label}`}
          className="mr-1 flex size-7 items-center justify-center rounded-sm text-inherit hover:bg-white/10"
        >
          <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
      </div>
      {expanded ? (
        <ul id={listId} className="mt-1 flex flex-col gap-0.5 pl-4">
          {children.map((child) => {
            const current = isCurrent(pathname, child.href);
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  prefetch={PREFETCH_PRIMARY}
                  onClick={onNavigate}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md px-3 text-[13px] transition-colors",
                    current ? "bg-white/10 font-medium text-fg" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                  )}
                >
                  <child.icon className="size-3.5 shrink-0" />
                  {child.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** The WorkEasy mark (public/brand/logo.png, transparent). Decorative: callers carry the accessible name. */
export function BrandLogo({ size = 24, className }: { size?: number; className?: string }) {
  return <Image src="/brand/logo.png" alt="" aria-hidden width={size} height={size} unoptimized priority className={cn("shrink-0", className)} />;
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/dashboard" className={cn("flex items-center gap-2 font-semibold text-fg", className)} aria-label="WorkEasy360 CRM home">
      <BrandLogo size={28} />
      <span className="text-[15px] tracking-tight">WorkEasy360</span>
      <span className="rounded-full bg-white px-1.5 py-px text-[10px] font-bold leading-4 text-chrome">CRM</span>
    </Link>
  );
}
