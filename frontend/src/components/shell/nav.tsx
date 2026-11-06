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
  ArrowRight,
  Bot,
  ChevronDown,
  Contact,
  CreditCard,
  DatabaseZap,
  FileText,
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
import { useAssistant } from "@/components/assistant/ask-keel";
import type { ActiveContext, Organization, Session } from "@/lib/api/types";
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
  { href: "/settings/pipelines", label: "Pipeline Stages", icon: KanbanSquare, visible: (a) => hasPermission(a, "pipelines.manage") },
  { href: "/settings/custom-fields", label: "Fields & Forms", icon: SlidersHorizontal, visible: (a) => hasPermission(a, "customfields.manage") },
  { href: "/settings/automation", label: "Automation", icon: Workflow, visible: (a) => hasPermission(a, "automation.view") },
  { href: "/settings/integrations", label: "Integrations", icon: PlugZap, visible: (a) => anyOf(a, ["integrations.view", "webhooks.manage"]) },
  { href: "/settings/whatsapp", label: "WhatsApp (API)", icon: MessageCircle, visible: (a) => hasPermission(a, "whatsapp.view") },
  { href: "/settings/email", label: "Email", icon: Mail, visible: (a) => hasPermission(a, "email.view") },
  { href: "/settings/templates", label: "Message Templates", icon: FileText, visible: (a) => anyOf(a, ["email.view", "whatsapp.view"]) },
  { href: "/settings/billing", label: "Billing & Subscription", icon: CreditCard, visible: (a) => anyOf(a, ["org.billing", "org.update"]) },
  { href: "/settings/price-books", label: "Price books", icon: BookOpen, visible: (a) => hasPermission(a, "pricebooks.manage") },
  { href: "/settings/tags", label: "Tags", icon: Tag, visible: (a) => hasPermission(a, "tags.manage") },
  { href: "/settings/notifications", label: "Notifications", icon: Bell, visible: () => true },
  { href: "/settings/ai", label: "AI", icon: Sparkles, visible: (a) => hasPermission(a, "ai.settings.manage") },
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

export function SideNav({ onNavigate }: { session: Session; onNavigate?: () => void }) {
  const pathname = usePathname();
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

      <div className="mt-auto px-3 pb-3">
        <AiPromoCard onNavigate={onNavigate} />
      </div>
    </nav>
  );
}

/** The sidebar's "WorkEasy AI" card: a way into the assistant from every page. */
const ASK_NOW =
  "mt-2.5 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-white text-sm font-semibold text-chrome hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AiPromoCard({ onNavigate }: { onNavigate?: () => void }) {
  const assistant = useAssistant();
  return (
    <section aria-label="WorkEasy AI" className="rounded-xl border border-brand/60 bg-white/5 px-3 pb-3 pt-3 text-center shadow-[0_0_18px_-6px_var(--kl-brand)]">
      <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-white text-chrome shadow-sm">
        <Bot className="size-6" aria-hidden />
      </span>
      <p className="mt-2 text-base font-bold text-fg">WorkEasy AI</p>
      <p className="mt-0.5 text-xs leading-snug text-fg-muted">Your AI CRM Assistant for Sales, Follow-ups &amp; Automation.</p>
      {assistant?.available ? (
        // The same assistant as the floating button: opens the side panel on whatever page this is.
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            assistant.openPanel();
          }}
          className={ASK_NOW}
        >
          Ask AI Now <ArrowRight className="size-4" aria-hidden />
        </button>
      ) : (
        <Link href="/assistant" prefetch={PREFETCH_PRIMARY} onClick={onNavigate} className={ASK_NOW}>
          Ask AI Now <ArrowRight className="size-4" aria-hidden />
        </Link>
      )}
    </section>
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

/** Sidebar brand: the workspace's logo and CRM name from General settings, else the WorkEasy360 mark. */
export function Wordmark({ className, organization }: { className?: string; organization?: Pick<Organization, "crm_name" | "logo_url" | "name"> | null }) {
  const name = organization?.crm_name?.trim() || "WorkEasy360";
  const pill = !/\bcrm$/i.test(name);
  return (
    <Link href="/dashboard" className={cn("flex min-w-0 items-center gap-2 font-semibold text-fg", className)} aria-label={`${name}${pill ? " CRM" : ""} home`}>
      {organization?.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a same-origin image behind the session, not optimisable
        <img src={organization.logo_url} alt="" aria-hidden width={28} height={28} className="size-7 shrink-0 rounded-sm bg-white object-contain" />
      ) : (
        <BrandLogo size={28} />
      )}
      <span className="truncate text-[15px] tracking-tight">{name}</span>
      {pill ? <span className="rounded-full bg-white px-1.5 py-px text-[10px] font-bold leading-4 text-chrome">CRM</span> : null}
    </Link>
  );
}
