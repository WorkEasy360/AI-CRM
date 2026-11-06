"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseZap, Download, FileArchive, FileUp, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createExport, exportDownloadUrl, listExports, listImports, type ExportEntity, type ImportEntity } from "@/lib/api/crm";
import type { ExportJob, ImportJob } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";
import { IMPORT_ENTITIES, POLL_MS, StatusBadge, formatBytes, isActive } from "@/components/settings/import-shared";
import { ImportJobView, ImportMapping, ImportUpload, RollbackAction, newDraft, type ImportDraft } from "@/components/settings/import-wizard";

const EXPORT_ENTITIES: { key: ExportEntity; label: string }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "companies", label: "Companies" },
  { key: "deals", label: "Deals" },
  { key: "products", label: "Products" },
];
const FULL_EXPORT = { key: "all" as const, label: "Everything (.zip)" };

function isImportEntity(value: string): value is ImportEntity {
  return IMPORT_ENTITIES.some((e) => e.key === value);
}
function isExportEntity(value: string): value is ExportEntity {
  return value === FULL_EXPORT.key || EXPORT_ENTITIES.some((e) => e.key === value);
}

export function DataPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const importable = IMPORT_ENTITIES.filter((e) => hasPermission(active, `${e.key}.import`));
  const exportable = EXPORT_ENTITIES.filter((e) => hasPermission(active, `${e.key}.export`));

  if (importable.length === 0 && exportable.length === 0) {
    return (
      <div>
        <PageHeader title="Data" />
        <EmptyState icon={<DatabaseZap />} title="No access" description="Your role does not include permission to import or export data." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Data" description="Bring records in from CSV or Excel files and take your data with you." />
      <div className="grid gap-6">
        {importable.length > 0 ? <ImportSection entities={importable} /> : null}
        {exportable.length > 0 ? <ExportSection entities={exportable} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ import */

function ImportSection({ entities }: { entities: { key: ImportEntity; label: string }[] }) {
  const queryClient = useQueryClient();
  const [entity, setEntity] = React.useState<ImportEntity>(entities[0]?.key ?? "contacts");
  const [draft, setDraft] = React.useState<ImportDraft | null>(null);
  const [viewJobId, setViewJobId] = React.useState<string | null>(null);

  const history = useQuery({
    queryKey: crmKeys.imports(entity),
    queryFn: () => listImports(entity),
    refetchInterval: (query) => (query.state.data?.results.some((job) => isActive(job.status)) ? POLL_MS : false),
  });

  const changeEntity = (value: string) => {
    if (!isImportEntity(value)) return;
    setEntity(value);
    setDraft(null);
    setViewJobId(null);
  };

  const reset = () => {
    setDraft(null);
    setViewJobId(null);
  };

  const onStatus = React.useCallback(
    (job: ImportJob) => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.imports(entity) });
      if (job.status === "completed" || job.status === "stopped" || job.status === "failed" || job.status === "rolled_back") {
        void queryClient.invalidateQueries({ queryKey: ["crm", entity] });
        void queryClient.invalidateQueries({ queryKey: ["billing"] });
      }
    },
    [queryClient, entity],
  );

  const openJob = (job: ImportJob) => {
    queryClient.setQueryData(crmKeys.importJob(entity, job.id), job);
    setViewJobId(job.id);
    void queryClient.invalidateQueries({ queryKey: crmKeys.imports(entity) });
  };

  const entityLabel = entities.find((e) => e.key === entity)?.label ?? entity;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileUp className="size-4 text-primary" aria-hidden /> Import from CSV or Excel
        </CardTitle>
        <CardDescription>Upload a file, match its columns to fields, check it, then run the import in the background.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="import-entity">Record type</Label>
          <Select value={entity} onValueChange={changeEntity} disabled={Boolean(viewJobId) || Boolean(draft)}>
            <SelectTrigger id="import-entity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {entities.map((e) => (
                <SelectItem key={e.key} value={e.key}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {viewJobId ? (
          <ImportJobView
            entity={entity}
            jobId={viewJobId}
            onBack={reset}
            onEditMapping={draft?.job.id === viewJobId ? () => setViewJobId(null) : undefined}
            onStatus={onStatus}
          />
        ) : draft ? (
          <ImportMapping entity={entity} draft={draft} onChange={setDraft} onCancel={() => setDraft(null)} onChecked={openJob} />
        ) : (
          <ImportUpload entity={entity} entityLabel={entityLabel} onUploaded={(job) => setDraft(newDraft(job))} />
        )}

        <div>
          <h3 className="mb-2 text-sm font-semibold">Your recent imports</h3>
          {history.isPending ? (
            <SkeletonRows rows={2} />
          ) : history.isError ? (
            <p className="text-sm text-danger">{errorMessage(history.error)}</p>
          ) : history.data.results.length === 0 ? (
            <p className="text-sm text-fg-muted">No {entityLabel.toLowerCase()} imports yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Rows</TableHead>
                  <TableHead className="hidden md:table-cell">Started</TableHead>
                  <TableHead className="w-40">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data.results.map((job) => (
                  <ImportHistoryRow key={job.id} entity={entity} job={job} onView={() => setViewJobId(job.id)} onRollbackStarted={openJob} />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function rowCounts(job: ImportJob): string {
  const parts = [`${job.created_rows.toLocaleString()} created`];
  if (job.updated_rows > 0) parts.push(`${job.updated_rows.toLocaleString()} updated`);
  if (job.skipped_rows > 0) parts.push(`${job.skipped_rows.toLocaleString()} skipped`);
  return parts.join(" · ");
}

export function ImportHistoryRow({
  entity,
  job,
  onView,
  onRollbackStarted,
}: {
  entity: ImportEntity;
  job: ImportJob;
  onView: () => void;
  onRollbackStarted: (job: ImportJob) => void;
}) {
  const rb = job.rollback ?? {};
  return (
    <TableRow>
      <TableCell>
        <span className="block max-w-[14rem] truncate font-medium" title={job.original_filename}>
          {job.original_filename || "Untitled"}
        </span>
        <span className="text-xs text-fg-subtle">{formatBytes(job.size_bytes)}</span>
      </TableCell>
      <TableCell>
        <StatusBadge status={job.status} />
        {job.status === "stopped" ? (
          <p className="mt-1 max-w-xs text-xs text-warning">
            {job.stop?.message || "Stopped at your plan's record limit."}
            {job.stop?.upgrade?.required_edition ? ` Upgrade to ${job.stop.upgrade.required_edition.name} to import the rest.` : ""}
          </p>
        ) : null}
        {job.status === "failed" && job.error_message ? <p className="mt-1 max-w-xs text-xs text-danger">{job.error_message}</p> : null}
        {job.status === "rolled_back" ? (
          <p className="mt-1 max-w-xs text-xs text-fg-muted">
            {(rb.deleted ?? 0).toLocaleString()} deleted · {(rb.reverted ?? 0).toLocaleString()} restored
            {rb.conflict_count ? ` · ${rb.conflict_count.toLocaleString()} left unchanged` : ""}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-fg-muted sm:table-cell">
        {rowCounts(job)}
        {job.error_rows > 0 ? <span className="text-danger"> · {job.error_rows.toLocaleString()} errors</span> : null}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-fg-muted md:table-cell">{formatDateTime(job.started_at ?? job.created_at)}</TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-1">
          {job.status !== "uploaded" ? (
            <Button variant="ghost" size="sm" onClick={onView}>
              View
            </Button>
          ) : null}
          <RollbackAction entity={entity} job={job} onStarted={onRollbackStarted} />
        </div>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------ export */

function ExportSection({ entities }: { entities: { key: ExportEntity; label: string }[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [entity, setEntity] = React.useState<ExportEntity>(entities[0]?.key ?? "contacts");
  const options = [...entities, FULL_EXPORT];

  const exports = useQuery({
    queryKey: crmKeys.exports(entity),
    queryFn: () => listExports(entity),
    refetchInterval: (query) => (query.state.data?.results.some((job) => isActive(job.status)) ? POLL_MS : false),
  });

  const request = useMutation({
    mutationFn: (target: ExportEntity) => runSensitive(() => createExport(target)),
    onSuccess: async (_job, target) => {
      setEntity(target);
      await queryClient.invalidateQueries({ queryKey: crmKeys.exports(target) });
      toast({
        tone: "success",
        title: target === "all" ? "Full export requested" : "Export requested",
        description: "It will appear below as soon as the file is ready.",
      });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      toast({ tone: "error", title: "Could not request export", description: errorMessage(err) });
    },
  });

  const entityLabel = options.find((e) => e.key === entity)?.label ?? entity;
  const now = Date.now();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="size-4 text-primary" aria-hidden /> Export to CSV
        </CardTitle>
        <CardDescription>
          Exports include every record you can see, with custom fields and tags. &ldquo;Export everything&rdquo; gives one ZIP with a CSV per module. Files are kept for 24 hours.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="grid gap-1.5 sm:w-64">
            <Label htmlFor="export-entity">Record type</Label>
            <Select value={entity} onValueChange={(v) => isExportEntity(v) && setEntity(v)}>
              <SelectTrigger id="export-entity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((e) => (
                  <SelectItem key={e.key} value={e.key}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => request.mutate(entity)} loading={request.isPending && request.variables !== "all"} disabled={request.isPending}>
            <Download /> Request export
          </Button>
          {entity !== "all" ? (
            <Button
              variant="secondary"
              onClick={() => request.mutate("all")}
              loading={request.isPending && request.variables === "all"}
              disabled={request.isPending}
            >
              <FileArchive /> Export everything
            </Button>
          ) : null}
        </div>
        <ul className="grid gap-1 text-xs text-fg-subtle">
          <li>List filters are not applied yet: an export contains all {entity === "all" ? "records" : entityLabel.toLowerCase()} in your scope.</li>
          <li className="flex items-start gap-1.5">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>You will be asked to confirm your password. Cells that look like spreadsheet formulas are neutralised so the file is safe to open.</span>
          </li>
        </ul>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Export jobs</h3>
          {exports.isPending ? (
            <SkeletonRows rows={2} />
          ) : exports.isError ? (
            <p className="text-sm text-danger">{errorMessage(exports.error)}</p>
          ) : exports.data.results.length === 0 ? (
            <p className="text-sm text-fg-muted">{entity === "all" ? "No full exports yet." : `No ${entityLabel.toLowerCase()} exports yet.`}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Rows</TableHead>
                  <TableHead className="hidden md:table-cell">Size</TableHead>
                  <TableHead className="hidden md:table-cell">Expires</TableHead>
                  <TableHead className="w-28">
                    <span className="sr-only">Download</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exports.data.results.map((job) => (
                  <ExportRow key={job.id} entity={entity} job={job} now={now} />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ExportRow({ entity, job, now }: { entity: ExportEntity; job: ExportJob; now: number }) {
  const expiresAt = job.expires_at ? new Date(job.expires_at).getTime() : null;
  const expired = expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt <= now;
  const ready = job.status === "completed" && !expired;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <span className="block">{formatDateTime(job.created_at)}</span>
        {job.requested_by ? <span className="text-xs text-fg-subtle">{job.requested_by.display_name}</span> : null}
      </TableCell>
      <TableCell>
        <StatusBadge status={job.status} />
        {job.status === "failed" && job.error_message ? <p className="mt-1 max-w-xs text-xs text-danger">{job.error_message}</p> : null}
      </TableCell>
      <TableCell className="hidden text-fg-muted sm:table-cell">{job.status === "completed" ? job.row_count.toLocaleString() : "—"}</TableCell>
      <TableCell className="hidden text-fg-muted md:table-cell">{job.status === "completed" ? formatBytes(job.size_bytes) : "—"}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-fg-muted md:table-cell">
        {expired ? <span className="text-fg-subtle">Expired</span> : job.expires_at ? formatDateTime(job.expires_at) : "—"}
      </TableCell>
      <TableCell>
        {ready ? (
          <Button asChild variant="secondary" size="sm">
            <a href={exportDownloadUrl(entity, job.id)} download>
              <Download /> {entity === "all" ? "Download .zip" : "Download"}
            </a>
          </Button>
        ) : expired ? (
          <span className="text-xs text-fg-subtle">No longer available</span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
