"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronDown, List, Plus, Star, Tag, Upload, UserRound, Users } from "lucide-react";
import { KpiTile, percentChange } from "@/components/dashboard/stat-tile";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { contactStats, listTags } from "@/lib/api/crm";
import type { ContactStats } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

export type ContactsTab = "all" | "people" | "companies" | "favorites" | "tag";
export type AddKind = "individual" | "company";

export function useContactStats() {
  return useQuery({ queryKey: crmKeys.stats("contacts"), queryFn: contactStats, staleTime: 30_000 });
}

/** Header, KPI row and the tab bar shared by the Contacts and Companies pages. */
export function ContactsHub({ active, tagId, onAdd }: { active: ContactsTab; tagId?: string; onAdd: (kind: AddKind) => void }) {
  const stats = useContactStats();
  return (
    <>
      <PageHeader icon={Users} title="Contacts" description="Manage all your people and companies in one place." />
      <ContactKpis stats={stats.data} />
      <ContactsTabBar active={active} tagId={tagId} stats={stats.data} onAdd={onAdd} />
    </>
  );
}

export function ContactKpis({ stats }: { stats: ContactStats | undefined }) {
  const c = stats?.companies ?? null;
  const days = stats?.days ?? 30;
  const versus = `new in the last ${days} days vs the ${days} before`;
  const people = stats?.total ?? 0;
  const value = (n: number | undefined) => (stats ? (n ?? 0).toLocaleString() : undefined);
  return (
    <section aria-label="Contact summary" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      <KpiTile tone="green" icon={<Users />} label="Total Contacts" value={value(people + (c?.total ?? 0))} change={stats ? percentChange((stats.created ?? 0) + (c?.created ?? 0), (stats.created_previous ?? 0) + (c?.created_previous ?? 0), versus) : null} changeNote="" />
      <KpiTile tone="blue" icon={<UserRound />} label="Individuals" value={value(people)} change={stats ? percentChange(stats.created, stats.created_previous, versus) : null} changeNote="" href="/contacts?tab=people" />
      <KpiTile tone="green" icon={<Building2 />} label="Companies" value={stats ? (c ? c.total.toLocaleString() : "—") : undefined} change={c ? percentChange(c.created, c.created_previous, versus) : null} changeNote="" sub={stats && !c ? "No access" : undefined} href="/companies" />
      <KpiTile tone="orange" icon={<Star />} label="Favorites" value={value((stats?.favorites ?? 0) + (c?.favorites ?? 0))} sub="Starred by you" href="/contacts?tab=favorites" />
      <KpiTile tone="pink" icon={<Tag />} label="Tagged" value={value((stats?.tagged ?? 0) + (c?.tagged ?? 0))} sub="With at least one tag" />
    </section>
  );
}

function ContactsTabBar({ active, tagId, stats, onAdd }: { active: ContactsTab; tagId?: string; stats: ContactStats | undefined; onAdd: (kind: AddKind) => void }) {
  const { data: session } = useSession();
  const permissions = session?.active ?? null;
  const tags = useQuery({ queryKey: crmKeys.tags, queryFn: listTags, staleTime: 60_000, enabled: can(permissions, "tags.view") });
  const c = stats?.companies ?? null;
  const count = (n: number | undefined) => (stats ? ` (${(n ?? 0).toLocaleString()})` : "");
  const items: { key: ContactsTab; href: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "all", href: "/contacts", label: `All Contacts${count((stats?.total ?? 0) + (c?.total ?? 0))}`, icon: List },
    { key: "people", href: "/contacts?tab=people", label: `Individuals${count(stats?.total)}`, icon: UserRound },
    ...(c ? [{ key: "companies" as const, href: "/companies", label: `Companies${count(c.total)}`, icon: Building2 }] : []),
    { key: "favorites", href: "/contacts?tab=favorites", label: `Favorites${count((stats?.favorites ?? 0) + (c?.favorites ?? 0))}`, icon: Star },
  ];
  const current = tags.data?.results.find((t) => t.id === tagId);
  const canIndividual = can(permissions, "contacts.create");
  const canCompany = can(permissions, "companies.create");
  const canImport = can(permissions, "contacts.import") || can(permissions, "companies.import");
  return (
    <div className="mb-3 mt-4 flex flex-wrap items-center gap-2">
      <nav aria-label="Contacts views" className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-surface p-1 shadow-sm">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            prefetch
            aria-current={item.key === active ? "page" : undefined}
            className={cn("inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors", item.key === active ? "bg-brand text-brand-fg shadow-sm" : "text-fg hover:bg-bg-subtle")}
          >
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </Link>
        ))}
        {tags.data && tags.data.results.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn("inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium", active === "tag" ? "bg-brand text-brand-fg shadow-sm" : "text-fg hover:bg-bg-subtle")}>
                <Tag className="size-4" aria-hidden />
                {current ? current.name : "Tags"}
                <ChevronDown className="size-4 opacity-70" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
              <DropdownMenuLabel>Show contacts tagged</DropdownMenuLabel>
              {tags.data.results.map((t) => (
                <DropdownMenuItem key={t.id} asChild>
                  <Link href={`/contacts?tag=${encodeURIComponent(t.id)}`}>
                    {t.name}
                    {t.usage_count ? <span className="ml-auto text-xs text-fg-subtle">{t.usage_count}</span> : null}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </nav>
      {canIndividual || canCompany || canImport ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="ml-auto">
              <Plus /> Add Contact <ChevronDown className="opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {canIndividual ? (
              <DropdownMenuItem onSelect={() => onAdd("individual")}>
                <UserRound /> Individual
              </DropdownMenuItem>
            ) : null}
            {canCompany ? (
              <DropdownMenuItem onSelect={() => onAdd("company")}>
                <Building2 /> Company
              </DropdownMenuItem>
            ) : null}
            {canImport ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings/data">
                    <Upload /> Import
                  </Link>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
