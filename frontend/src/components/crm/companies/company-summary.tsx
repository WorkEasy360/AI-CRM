"use client";

import Link from "next/link";
import { Archive, ArchiveRestore, ExternalLink, MoreHorizontal, Pencil } from "lucide-react";
import { relativeTime } from "@/components/activities/activity-utils";
import { KeyFacts } from "@/components/crm/contacts/record-layout";
import { LifecycleStatusChanger } from "@/components/crm/lifecycle-select";
import { QuickActions } from "@/components/crm/quick-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Company } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { cn, formatDateTime } from "@/lib/utils";

/** Safe outbound link for a website: only http(s) URLs become anchors; anything else renders as text. */
export function websiteLink(website: string): { href: string; label: string } | null {
  try {
    const url = new URL(website.includes("://") ? website : `https://${website}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { href: url.toString(), label: url.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/** Company page header: name, industry, website, phone, owner, status changer, then quick actions. */
export function CompanyHeader({
  company,
  canEdit,
  canDelete,
  onEdit,
  onArchive,
  onRestore,
}: {
  company: Company;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const site = company.website ? websiteLink(company.website) : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{company.name}</h1>
            {company.archived_at ? <Badge variant="warning">Archived</Badge> : null}
          </div>
          {company.industry ? <div className="mt-0.5 text-sm text-fg-muted">{company.industry}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canEdit ? (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              <Pencil /> Edit
            </Button>
          ) : null}
          {canDelete ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {company.archived_at ? (
                  <DropdownMenuItem onSelect={onRestore}>
                    <ArchiveRestore /> Restore
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem destructive onSelect={onArchive}>
                    <Archive /> Archive
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <KeyFacts
        items={[
          {
            label: "Website",
            value: site ? (
              <a href={site.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-primary hover:underline">
                {site.label}
                <ExternalLink className="size-3 text-fg-subtle" aria-hidden />
              </a>
            ) : (
              company.website
            ),
          },
          { label: "Phone", value: company.phone ? <a href={`tel:${company.phone}`} className="hover:text-primary hover:underline">{company.phone}</a> : "" },
          { label: "Owner", value: company.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span> },
          { label: "Status", value: <LifecycleStatusChanger entity="company" record={company} disabled={!canEdit} /> },
        ]}
      />

      <QuickActions company={company} />
    </div>
  );
}

function Tile({ label, value, hint, href, className }: { label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; className?: string }) {
  const body = (
    <>
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums">{value}</div>
      {hint ? <div className="truncate text-xs text-fg-muted">{hint}</div> : null}
    </>
  );
  const cls = cn("min-w-0 rounded-md border border-border bg-surface px-3 py-2", className);
  if (href) {
    return (
      <Link href={href} className={cn(cls, "block hover:border-border-strong hover:bg-bg-subtle")}>
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** Five-tile strip: open deals, won revenue, contacts, last activity, next activity. */
export function CompanySummary({ company, currency }: { company: Company; currency: string }) {
  const nextOverdue = company.next_activity_at ? new Date(company.next_activity_at).getTime() < Date.now() : false;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Company summary">
      <Tile label="Open deals" value={company.open_deal_count.toLocaleString()} hint={formatMoney(company.open_deal_amount, currency)} />
      <Tile label="Won revenue" value={formatMoney(company.won_deal_amount, currency)} />
      <Tile label="Contacts" value={company.contact_count.toLocaleString()} />
      <Tile
        label="Last activity"
        value={company.last_activity_at ? relativeTime(company.last_activity_at) : <span className="font-normal text-fg-subtle">None yet</span>}
        hint={company.last_activity_at ? formatDateTime(company.last_activity_at) : undefined}
      />
      <Tile
        label="Next activity"
        value={company.next_activity_title || (company.next_activity_at ? "Scheduled" : <span className="font-normal text-fg-subtle">Nothing planned</span>)}
        hint={
          company.next_activity_at ? (
            <span className={nextOverdue ? "text-danger" : undefined}>
              {relativeTime(company.next_activity_at)} · {formatDateTime(company.next_activity_at)}
            </span>
          ) : undefined
        }
      />
    </div>
  );
}
