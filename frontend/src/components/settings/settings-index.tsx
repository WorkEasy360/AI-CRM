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
import { cn } from "@/lib/utils";

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
  description: string;
  icon: Icon;
  /** Header tint. */
  tint: string;
  /** Icon colour on the tint (>= 3:1). */
  ink: string;
  items: CardItem[];
}

/** The WorkEasy360 settings home: six groups, each linking to the existing settings pages. */
export const SETTINGS_CARDS: readonly SettingsCard[] = [
  {
    title: "Workspace",
    description: "Set up your organization and team.",
    icon: Building2,
    tint: "from-[#dcfce7]",
    ink: "text-[#15803d]",
    items: [
      { label: "Organization Details", href: "/settings/general", icon: Building2 },
      { label: "Users & Teams", href: "/settings/users", icon: Users },
      { label: "Roles & Permissions", href: "/settings/roles", icon: ShieldCheck },
    ],
  },
  {
    title: "CRM Configuration",
    description: "Customize your CRM for your sales process.",
    icon: Filter,
    tint: "from-[#dbeafe]",
    ink: "text-[#15803d]",
    items: [
      { label: "Pipelines & Stages", href: "/settings/pipelines", icon: Layers },
      { label: "Custom Fields", href: "/settings/custom-fields", icon: ListOrdered },
      { label: "Tags", href: "/settings/tags", icon: Tag },
    ],
  },
  {
    title: "Communication",
    description: "Connect and manage customer communication channels.",
    icon: MessageSquareMore,
    tint: "from-[#f3e8ff]",
    ink: "text-[#7e22ce]",
    items: [
      { label: "Email Settings", href: "/settings/email", icon: Mail },
      { label: "WhatsApp Integration", href: "/settings/whatsapp", icon: MessageCircle },
      { label: "Message Templates", href: "/settings/templates", icon: FileText },
      { label: "Notifications", href: "/settings/notifications", icon: Bell },
    ],
  },
  {
    title: "AI Assistant",
    description: "Enable AI to boost your sales and productivity.",
    icon: Cpu,
    tint: "from-[#ffedd5]",
    ink: "text-[#c2410c]",
    items: [
      { label: "AI Settings", href: "/settings/ai", icon: Sparkles },
      { label: "Usage & Limits", href: "/settings/ai#usage", icon: BarChart3, gate: "/settings/ai" },
      { label: "Knowledge Base", href: "/settings/ai/knowledge-base", icon: BookOpen, gate: "/settings/ai" },
    ],
  },
  {
    title: "Security & Data",
    description: "Keep your CRM secure and manage your data.",
    icon: ShieldCheck,
    tint: "from-[#dcfce7]",
    ink: "text-[#15803d]",
    items: [
      { label: "Password & 2FA", href: "/settings/security", icon: Lock },
      { label: "Import & Export Data", href: "/settings/data", icon: Database },
      { label: "Activity / Audit Log", href: "/settings/audit-log", icon: History },
    ],
  },
  {
    title: "Integrations & API",
    description: "Connect external apps and manage API access.",
    icon: PlugZap,
    tint: "from-[#dbeafe]",
    ink: "text-[#1d4ed8]",
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
      <PageHeader icon={Settings} title="Settings" description="Manage your CRM, team, communication, integrations and data in one place." />
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <section key={card.title} aria-label={card.title} className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <Link href={card.items[0]?.href ?? "/settings"} className={cn("group flex items-start gap-3 bg-gradient-to-r to-transparent px-4 py-4", card.tint)}>
              <span className={cn("flex size-14 shrink-0 items-center justify-center rounded-full bg-white/70", card.ink)} aria-hidden>
                <card.icon className="size-8" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-bold text-fg">{card.title}</span>
                <span className="block text-sm text-fg-muted">{card.description}</span>
              </span>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-fg shadow-sm group-hover:bg-bg-subtle" aria-hidden>
                <ChevronRight className="size-4" />
              </span>
            </Link>
            <ul className="divide-y divide-border px-4 pb-2">
              {card.items.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="flex items-center gap-3 rounded-sm py-2.5 text-sm font-medium text-fg hover:text-primary">
                    <item.icon className="size-5 shrink-0 text-fg-muted" aria-hidden />
                    {item.label}
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
