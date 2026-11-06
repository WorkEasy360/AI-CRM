"use client";

import * as React from "react";
import Link from "next/link";
import {
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  ChevronRight,
  Code2,
  Cpu,
  CreditCard,
  Database,
  FileText,
  Filter,
  History,
  Layers,
  ListOrdered,
  Lock,
  Mail,
  MessageCircle,
  MessageSquareMore,
  PlugZap,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Users,
  Webhook,
  Workflow,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { visibleSettingsNav } from "@/components/shell/nav";
import { SkeletonRows } from "@/components/ui/skeleton";
import type { ActiveContext } from "@/lib/api/types";
import { useSession } from "@/lib/session";

type Icon = React.ComponentType<{ className?: string }>;

interface CardItem {
  label: string;
  href: string;
  icon: Icon;
  /** The settings page whose visibility rule applies (defaults to ``href``). */
  gate?: string;
}

interface SettingsCard {
  title: string;
  icon: Icon;
  items: CardItem[];
}

/** The settings home: six groups, each linking to the existing settings pages. */
export const SETTINGS_CARDS: readonly SettingsCard[] = [
  {
    title: "Workspace",
    icon: Building2,
    items: [
      { label: "Organization Details", href: "/settings/general", icon: Building2 },
      { label: "Users & Teams", href: "/settings/users", icon: Users },
      { label: "Roles & Permissions", href: "/settings/roles", icon: ShieldCheck },
    ],
  },
  {
    title: "CRM Configuration",
    icon: Filter,
    items: [
      { label: "Pipelines & Stages", href: "/settings/pipelines", icon: Layers },
      { label: "Custom Fields", href: "/settings/custom-fields", icon: ListOrdered },
      { label: "Tags", href: "/settings/tags", icon: Tag },
    ],
  },
  {
    title: "Communication",
    icon: MessageSquareMore,
    items: [
      { label: "Email Settings", href: "/settings/email", icon: Mail },
      { label: "WhatsApp Integration", href: "/settings/whatsapp", icon: MessageCircle },
      { label: "Message Templates", href: "/settings/templates", icon: FileText },
      { label: "Notifications", href: "/settings/notifications", icon: Bell },
    ],
  },
  {
    title: "AI Assistant",
    icon: Cpu,
    items: [
      { label: "AI Settings", href: "/settings/ai", icon: Sparkles },
      { label: "Usage & Limits", href: "/settings/ai#usage", icon: BarChart3, gate: "/settings/ai" },
      { label: "Knowledge Base", href: "/settings/ai/knowledge-base", icon: BookOpen, gate: "/settings/ai" },
    ],
  },
  {
    title: "Security & Data",
    icon: ShieldCheck,
    items: [
      { label: "Password & 2FA", href: "/settings/security", icon: Lock },
      { label: "Import & Export Data", href: "/settings/data", icon: Database },
      { label: "Activity / Audit Log", href: "/settings/audit-log", icon: History },
    ],
  },
  {
    title: "Integrations & API",
    icon: PlugZap,
    items: [
      { label: "Integrations (Connected Apps)", href: "/settings/integrations", icon: Puzzle },
      { label: "API Keys", href: "/settings/integrations/api-keys", icon: Code2, gate: "/settings/integrations" },
      { label: "Webhooks", href: "/settings/integrations/webhooks", icon: Webhook, gate: "/settings/integrations" },
    ],
  },
];

/** Settings that are not in the six groups but stay one click away. */
const MORE: readonly CardItem[] = [
  { label: "Automation", href: "/settings/automation", icon: Workflow },
  { label: "Billing & Subscription", href: "/settings/billing", icon: CreditCard },
  { label: "Price books", href: "/settings/price-books", icon: BookOpen },
];

/** Cards and items the member may open. Purely for tidiness: every page and API authorizes on its own. */
export function visibleSettingsCards(active: ActiveContext | null | undefined) {
  const allowed = new Set(visibleSettingsNav(active).map((item) => item.href));
  const keep = (item: CardItem) => allowed.has(item.gate ?? item.href);
  return {
    cards: SETTINGS_CARDS.map((card) => ({ ...card, items: card.items.filter(keep) })).filter((card) => card.items.length > 0),
    more: MORE.filter(keep),
  };
}

export function SettingsIndex() {
  const { data: session } = useSession();
  if (!session) return <SkeletonRows rows={3} />;
  const { cards, more } = visibleSettingsCards(session.active);
  return (
    <div>
      <PageHeader icon={Settings} title="Settings" />
      <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
        {cards.map((card) => (
          <section key={card.title} aria-label={card.title} className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
            <Link href={card.items[0]?.href ?? "/settings"} className="group flex items-center gap-3 border-b border-border px-5 py-4 hover:bg-surface-sunken">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand" aria-hidden>
                <card.icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1 text-lg font-semibold text-fg">{card.title}</span>
              <ChevronRight className="size-4 shrink-0 text-fg-subtle group-hover:text-fg" aria-hidden />
            </Link>
            <ul className="px-2 py-2">
              {card.items.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="group flex items-center gap-3 rounded-sm px-3 py-2.5 text-sm font-medium text-fg hover:bg-bg-subtle">
                    <item.icon className="size-[18px] shrink-0 text-fg-subtle group-hover:text-brand" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <ChevronRight className="size-4 shrink-0 text-transparent group-hover:text-fg-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {more.length > 0 ? (
        <nav aria-label="More settings" className="mt-5 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-muted">Also in Settings:</span>
          {more.map((item) => (
            <Link key={item.href} href={item.href} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 font-medium text-fg hover:bg-bg-subtle">
              <item.icon className="size-4 text-fg-muted" aria-hidden />
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
