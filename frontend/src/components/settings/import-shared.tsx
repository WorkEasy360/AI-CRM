"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Sparkles } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ImportEntity } from "@/lib/api/crm";
import type { ImportJob, ImportPreview, ImportRowError, JobStatus, UpgradePath } from "@/lib/api/crm-types";

export const IMPORT_ENTITIES: { key: ImportEntity; label: string }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "companies", label: "Companies" },
  { key: "deals", label: "Deals" },
  { key: "products", label: "Products" },
];

/** How each module finds an existing record when duplicates are skipped or updated. */
export const DEDUPE_MATCH: Record<ImportEntity, string> = {
  contacts: "Matched by email, then phone.",
  companies: "Matched by website, then name.",
  deals: "Matched by deal name within the pipeline.",
  products: "Matched by SKU, then name.",
};

/** Contacts and deals carry a company column; missing companies can be created on the way. */
export function supportsCreateCompanies(entity: ImportEntity): boolean {
  return entity === "contacts" || entity === "deals";
}

export const POLL_MS = 2000;

/** Jobs whose status still changes in the background (the page polls these). */
export function isActive(status: JobStatus | undefined): boolean {
  return status === "pending" || status === "running" || status === "previewing" || status === "rolling_back";
}

export function canRollBack(job: Pick<ImportJob, "status">): boolean {
  return job.status === "completed" || job.status === "stopped" || job.status === "failed";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** The dry-run result on a checked job; `preview` is an empty object before the check (or sample rows on old servers). */
export function dryRun(job: ImportJob | undefined): ImportPreview | null {
  const preview = job?.preview;
  if (!preview || Array.isArray(preview) || !("rows_checked" in preview)) return null;
  return preview as ImportPreview;
}

/** First rows of the uploaded file. Older servers sent them as `preview`. */
export function sampleRows(job: ImportJob): Record<string, string>[] {
  if (job.sample) return job.sample;
  return Array.isArray(job.preview) ? job.preview : [];
}

function statusBadge(status: JobStatus): { label: string; variant: BadgeProps["variant"] } {
  switch (status) {
    case "uploaded":
      return { label: "Awaiting mapping", variant: "neutral" };
    case "previewing":
      return { label: "Checking", variant: "primary" };
    case "previewed":
      return { label: "Checked", variant: "neutral" };
    case "pending":
      return { label: "Queued", variant: "neutral" };
    case "running":
      return { label: "Running", variant: "primary" };
    case "completed":
      return { label: "Completed", variant: "success" };
    case "stopped":
      return { label: "Stopped at limit", variant: "warning" };
    case "failed":
      return { label: "Failed", variant: "danger" };
    case "rolling_back":
      return { label: "Rolling back", variant: "primary" };
    case "rolled_back":
      return { label: "Rolled back", variant: "neutral" };
    default:
      return { label: status, variant: "neutral" };
  }
}

export function StatusBadge({ status }: { status: JobStatus }) {
  const { label, variant } = statusBadge(status);
  return (
    <Badge variant={variant}>
      {isActive(status) ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      {label}
    </Badge>
  );
}

function upgradeLine(upgrade: UpgradePath | null | undefined): string {
  const target = upgrade?.required_edition;
  if (target) return `Upgrade to ${target.name}${upgrade?.addon ? " or buy a records add-on" : ""} to import the rest.`;
  if (upgrade?.addon) return "Buy a records add-on to import the rest.";
  return "Raise your record limit to import the rest.";
}

/** Inline plan-limit notice with the upgrade path (the global upgrade dialog only reacts to refused requests). */
export function PlanLimitNotice({ title, detail, upgrade }: { title: string; detail?: React.ReactNode; upgrade?: UpgradePath | null }) {
  return (
    <div role="status" className="flex flex-wrap items-start gap-3 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-sm">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="font-medium text-fg">{title}</p>
        {detail ? <p className="text-xs text-fg-muted">{detail}</p> : null}
        <p className="text-xs text-fg-muted">{upgradeLine(upgrade)}</p>
      </div>
      <Button asChild size="sm" variant="secondary">
        <Link href={upgrade?.url || "/settings/billing"}>{upgrade?.required_edition ? "Compare plans" : "View add-ons"}</Link>
      </Button>
    </div>
  );
}

export function RowErrorsTable({ errors }: { errors: ImportRowError[] }) {
  return (
    <div className="mt-2 max-h-72 overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Row</TableHead>
            <TableHead className="w-40">Field</TableHead>
            <TableHead>Problem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {errors.flatMap((rowError) =>
            rowError.errors.map((e, i) => (
              <TableRow key={`${rowError.row}-${e.field}-${i}`}>
                <TableCell className="font-mono text-xs">{rowError.row}</TableCell>
                <TableCell className="font-mono text-xs">{e.field}</TableCell>
                <TableCell className="text-xs">{e.message}</TableCell>
              </TableRow>
            )),
          )}
        </TableBody>
      </Table>
    </div>
  );
}

const CONFLICT_REASONS: Record<string, string> = {
  changed_since_import: "Changed since the import",
  has_notes: "Has notes",
  has_files: "Has files",
  archived_since_import: "Archived since the import",
  not_permitted: "You can't change this record",
};

export function conflictReason(reason: string): string {
  if (CONFLICT_REASONS[reason]) return CONFLICT_REASONS[reason];
  if (reason.startsWith("linked_")) return `Linked to other records (${reason.slice("linked_".length).replace(/_/g, " ")})`;
  return reason.replace(/_/g, " ");
}

const RECORD_PATHS: Record<string, string> = { contact: "contacts", company: "companies", deal: "deals", product: "products" };

/** What a finished (or running) rollback did, and which records it left alone. */
export function RollbackSummary({ job }: { job: ImportJob }) {
  const r = job.rollback ?? {};
  const conflicts = r.conflicts ?? [];
  const conflictCount = r.conflict_count ?? conflicts.length;
  return (
    <div className="grid gap-2" aria-label="Rollback summary">
      <h4 className="text-sm font-semibold">{job.status === "rolling_back" ? "Rolling back…" : "Rollback"}</h4>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-fg-subtle">Deleted</dt>
          <dd className="font-semibold">{(r.deleted ?? 0).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Restored</dt>
          <dd className="font-semibold">{(r.reverted ?? 0).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Already gone</dt>
          <dd className="font-semibold">{(r.missing ?? 0).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Left unchanged</dt>
          <dd className={conflictCount > 0 ? "font-semibold text-warning" : "font-semibold"}>{conflictCount.toLocaleString()}</dd>
        </div>
      </dl>
      {conflicts.length > 0 ? (
        <details open>
          <summary className="cursor-pointer text-sm font-medium">Records left unchanged ({conflictCount.toLocaleString()})</summary>
          <div className="mt-2 max-h-72 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Row</TableHead>
                  <TableHead className="w-32">Record</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conflicts.map((c, i) => {
                  const path = RECORD_PATHS[c.entity_type];
                  return (
                    <TableRow key={`${c.row}-${c.entity_id}-${i}`}>
                      <TableCell className="font-mono text-xs">{c.row}</TableCell>
                      <TableCell className="text-xs capitalize">
                        {path ? (
                          <Link href={`/${path}/${encodeURIComponent(c.entity_id)}`} className="text-primary hover:underline">
                            {c.entity_type}
                          </Link>
                        ) : (
                          c.entity_type
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{conflictReason(c.reason)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </details>
      ) : null}
    </div>
  );
}
