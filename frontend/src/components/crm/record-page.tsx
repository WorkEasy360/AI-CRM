"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { cn } from "@/lib/utils";

/** Header + tab layout shared by the contact/company/product/deal detail pages. */
export function RecordPage({
  backHref,
  backLabel,
  title,
  subtitle,
  badges,
  actions,
  archived,
  tabs,
  defaultTab,
  aside,
}: {
  backHref: string;
  backLabel: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  archived?: boolean;
  tabs: { value: string; label: string; content: React.ReactNode }[];
  defaultTab?: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button asChild variant="link" size="sm" className="mb-2 h-auto px-0 text-fg-muted">
          <Link href={backHref}>
            <ArrowLeft /> {backLabel}
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
              {archived ? <Badge variant="warning">Archived</Badge> : null}
              {badges}
            </div>
            {subtitle ? <div className="mt-1 text-sm text-fg-muted">{subtitle}</div> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      <div className={cn("grid gap-6", aside && "xl:grid-cols-[minmax(0,1fr)_20rem]")}>
        <Tabs defaultValue={defaultTab ?? tabs[0]?.value}>
          <TabsList className="flex-wrap">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
        {aside ? <aside className="flex flex-col gap-4">{aside}</aside> : null}
      </div>
    </div>
  );
}

export function RecordPageSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-9 w-80" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export function RecordPageError({ error, backHref, backLabel }: { error: unknown; backHref: string; backLabel: string }) {
  const notFound = isApiError(error) && error.status === 404;
  return (
    <EmptyState
      title={notFound ? "Record not found" : "Could not load this record"}
      description={notFound ? "It may have been removed, or you do not have access to it." : errorMessage(error)}
      action={
        <Button asChild variant="secondary">
          <Link href={backHref}>{backLabel}</Link>
        </Button>
      }
    />
  );
}

/** Key/value grid used on detail pages. */
export function Facts({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-fg-subtle">{item.label}</dt>
          <dd className="truncate text-sm">{item.value === "" || item.value === null || item.value === undefined ? "—" : item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
