"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Detail-page frame for contacts and companies: back link, a free-form header block (title, key facts,
 * quick actions), then tabs beside a compact aside. Tabs whose content is `null` are hidden, which is
 * how permission-gated tabs (emails, WhatsApp, activities) drop out.
 */
export function RecordLayout({
  backHref,
  backLabel,
  header,
  tabs,
  defaultTab,
  aside,
}: {
  backHref: string;
  backLabel: string;
  header: React.ReactNode;
  tabs: { value: string; label: string; content: React.ReactNode }[];
  defaultTab?: string;
  aside?: React.ReactNode;
}) {
  const visible = tabs.filter((t) => t.content !== null && t.content !== undefined);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="link" size="sm" className="mb-2 h-auto px-0 text-fg-muted">
          <Link href={backHref}>
            <ArrowLeft /> {backLabel}
          </Link>
        </Button>
        {header}
      </div>
      <div className={cn("grid gap-6", aside && "xl:grid-cols-[minmax(0,1fr)_18rem]")}>
        <Tabs defaultValue={defaultTab ?? visible[0]?.value} className="min-w-0">
          <TabsList className="h-auto flex-wrap" aria-label="Record sections">
            {visible.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="h-7">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {visible.map((t) => (
            <TabsContent key={t.value} value={t.value}>
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
        {aside ? <aside className="flex flex-col gap-3">{aside}</aside> : null}
      </div>
    </div>
  );
}

/** Compact key/value row used in record headers ("Phone · Email · Owner…"). */
export function KeyFacts({ items, className }: { items: { label: string; value: React.ReactNode }[]; className?: string }) {
  const filled = items.filter((i) => i.value !== null && i.value !== undefined && i.value !== "");
  if (filled.length === 0) return null;
  return (
    <dl className={cn("flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm", className)}>
      {filled.map((item) => (
        <div key={item.label} className="flex min-w-0 items-center gap-1.5">
          <dt className="text-xs text-fg-subtle">{item.label}</dt>
          <dd className="min-w-0 truncate">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Accessible disclosure ("More details" / "Details"). Controlled or uncontrolled; the trigger carries
 * `aria-expanded` and the region is hidden from the tree when collapsed.
 */
export function Disclosure({
  title,
  summary,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  className,
  bordered = false,
}: {
  title: string;
  /** Short hint shown next to the title while collapsed, e.g. "Job title, source, address…". */
  summary?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  bordered?: boolean;
}) {
  const [internal, setInternal] = React.useState(defaultOpen);
  const isOpen = open ?? internal;
  const reactId = React.useId();
  const regionId = `disclosure-${reactId}`;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInternal(next);
    onOpenChange?.(next);
  };
  return (
    <div className={cn(bordered && "rounded-md border border-border bg-surface", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={regionId}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm text-left text-sm font-semibold text-fg hover:text-primary focus-visible:outline-2 focus-visible:outline-ring/40",
          bordered ? "px-4 py-3" : "py-1",
        )}
      >
        {isOpen ? <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden /> : <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />}
        <span>{title}</span>
        {!isOpen && summary ? <span className="truncate text-xs font-normal text-fg-subtle">{summary}</span> : null}
      </button>
      {isOpen ? (
        <div id={regionId} className={cn(bordered ? "border-t border-border px-4 py-3" : "pt-2")}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
