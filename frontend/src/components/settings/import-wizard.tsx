"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileSpreadsheet, FileUp, Loader2, RefreshCw, Undo2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { checkImport, getImport, rollbackImport, startImport, suggestImportMapping, uploadImport, type ImportEntity } from "@/lib/api/crm";
import type { DedupeMode, ImportJob, ImportPreview } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { cn, formatDateTime } from "@/lib/utils";
import {
  DEDUPE_MATCH,
  POLL_MS,
  PlanLimitNotice,
  RollbackSummary,
  RowErrorsTable,
  StatusBadge,
  canRollBack,
  dryRun,
  formatBytes,
  isActive,
  sampleRows,
  supportsCreateCompanies,
} from "@/components/settings/import-shared";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
/** Radix Select forbids an empty-string item value, so "skip" / "no preset" get sentinels. */
const SKIP = "__skip__";
const NO_PRESET = "__none__";

const DEDUPE_OPTIONS: { value: DedupeMode; label: string }[] = [
  { value: "create", label: "Create new" },
  { value: "skip", label: "Skip duplicates" },
  { value: "update", label: "Update duplicates" },
];

function isDedupeMode(value: string): value is DedupeMode {
  return DEDUPE_OPTIONS.some((o) => o.value === value);
}

/** Everything chosen for an uploaded file before it is checked; kept so "Change mapping" returns to it. */
export interface ImportDraft {
  job: ImportJob;
  mapping: Record<string, string>;
  preset: string;
  dedupe: DedupeMode;
  createCompanies: boolean;
}

function allowedMapping(job: ImportJob, suggested: Record<string, string> | undefined): Record<string, string> {
  const targets = job.targets ?? {};
  const out: Record<string, string> = {};
  for (const header of job.headers) {
    const target = suggested?.[header] ?? "";
    out[header] = target in targets ? target : "";
  }
  return out;
}

export function newDraft(job: ImportJob): ImportDraft {
  return { job, mapping: allowedMapping(job, job.mapping), preset: "", dedupe: "create", createCompanies: true };
}

/* ------------------------------------------------------------------ upload */

function validateFile(file: File): string | null {
  if (!/\.(csv|xlsx)$/i.test(file.name)) return "Choose a .csv or .xlsx file.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_FILE_BYTES) return `The file is ${formatBytes(file.size)}; the limit is 5 MB.`;
  return null;
}

export function ImportUpload({ entity, entityLabel, onUploaded }: { entity: ImportEntity; entityLabel: string; onUploaded: (job: ImportJob) => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (f: File) => uploadImport(entity, f),
    onSuccess: (job) => {
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onUploaded(job);
    },
    onError: (err) => {
      if (isApiError(err) && err.isValidation) {
        const errors = err.fieldErrors();
        setFileError(errors.file ?? errors.non_field_errors ?? err.summary());
      } else {
        setFileError(errorMessage(err, "Upload failed."));
      }
    },
  });

  const pick = (candidate: File | undefined | null) => {
    if (!candidate) return;
    const problem = validateFile(candidate);
    setFileError(problem);
    setFile(problem ? null : candidate);
  };

  return (
    <div className="grid gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center transition-colors",
          dragging ? "border-primary bg-primary-soft" : "border-border-strong bg-bg-subtle/50",
        )}
      >
        <FileSpreadsheet className="size-8 text-fg-subtle" aria-hidden />
        {file ? (
          <p className="text-sm">
            <span className="font-medium">{file.name}</span> <span className="text-fg-subtle">({formatBytes(file.size)})</span>
          </p>
        ) : (
          <p className="text-sm text-fg-muted">Drop a CSV or Excel file here, or choose one from your computer.</p>
        )}
        <Label htmlFor="import-file" className="cursor-pointer rounded-sm border border-border-strong bg-surface px-3 py-1.5 text-sm shadow-sm hover:bg-bg-subtle">
          {file ? "Choose a different file" : "Choose file"}
        </Label>
        <input
          ref={inputRef}
          id="import-file"
          type="file"
          accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          aria-describedby="import-file-help"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <p id="import-file-help" className="text-xs text-fg-subtle">
          .csv (UTF-8) or .xlsx, up to 5 MB, {MAX_ROWS.toLocaleString()} rows and 60 columns. The first row must contain column headers.
        </p>
      </div>
      <FormError message={fileError} />
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => file && upload.mutate(file)} disabled={!file} loading={upload.isPending}>
          <FileUp /> Upload and map columns
        </Button>
        <span className="text-xs text-fg-subtle">Nothing is imported until you check the file and confirm.</span>
      </div>
      <p className="text-xs text-fg-subtle">
        Importing {entityLabel.toLowerCase()}: rows that fail validation are skipped and reported with their row number; the rest are imported.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ mapping */

function sampleValues(job: ImportJob, header: string): string {
  return sampleRows(job)
    .map((row) => row[header])
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .slice(0, 3)
    .join(" · ");
}

export function ImportMapping({
  entity,
  draft,
  onChange,
  onCancel,
  onChecked,
}: {
  entity: ImportEntity;
  draft: ImportDraft;
  onChange: (draft: ImportDraft) => void;
  onCancel: () => void;
  onChecked: (job: ImportJob) => void;
}) {
  const { job, mapping } = draft;
  const targets = React.useMemo(() => Object.entries(job.targets ?? {}).sort((a, b) => a[1].localeCompare(b[1])), [job.targets]);
  const presets = job.presets ?? [];
  const [error, setError] = React.useState<string | null>(null);

  const suggest = useMutation({
    mutationFn: (preset: string) => suggestImportMapping(entity, job.id, preset || undefined),
    onSuccess: (result, preset) => {
      setError(null);
      onChange({ ...draft, preset, mapping: allowedMapping(job, result.mapping) });
    },
    onError: (err) => setError(errorMessage(err, "Could not apply the preset.")),
  });

  const check = useMutation({
    mutationFn: () =>
      checkImport(entity, job.id, mapping, {
        dedupe: draft.dedupe,
        ...(supportsCreateCompanies(entity) ? { create_companies: draft.createCompanies } : {}),
      }),
    onSuccess: onChecked,
    onError: (err) => {
      if (isApiError(err) && err.isValidation) {
        const errors = err.fieldErrors();
        setError(errors.mapping ?? errors.options ?? errors.non_field_errors ?? err.summary());
      } else {
        setError(errorMessage(err, "Could not check the file."));
      }
    },
  });

  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const usedBy = React.useMemo(() => {
    const out = new Map<string, string[]>();
    for (const [header, target] of Object.entries(mapping)) {
      if (!target) continue;
      out.set(target, [...(out.get(target) ?? []), header]);
    }
    return out;
  }, [mapping]);
  const duplicates = [...usedBy.entries()].filter(([, headers]) => headers.length > 1);

  const submit = () => {
    if (mappedCount === 0) {
      setError("Map at least one column to a field.");
      return;
    }
    if (duplicates.length > 0) {
      const names = duplicates.map(([target]) => job.targets?.[target] ?? target).join(", ");
      setError(`Each field can receive only one column. Mapped more than once: ${names}.`);
      return;
    }
    setError(null);
    check.mutate();
  };

  const busy = check.isPending || suggest.isPending;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Map columns</h3>
          <p className="text-xs text-fg-muted">
            <span className="font-medium text-fg">{job.original_filename}</span> · {job.total_rows.toLocaleString()} rows · {job.headers.length} columns. Suggested matches are
            pre-selected.
          </p>
        </div>
        <Badge variant="neutral">
          {mappedCount} of {job.headers.length} mapped
        </Badge>
      </div>

      {presets.length > 0 ? (
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="import-preset">Mapping preset</Label>
          <Select value={draft.preset || NO_PRESET} onValueChange={(v) => suggest.mutate(v === NO_PRESET ? "" : v)} disabled={busy}>
            <SelectTrigger id="import-preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PRESET}>Match by column name</SelectItem>
              {presets.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-fg-subtle">Moving from another CRM? Pick it to map its export columns.</p>
        </div>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>File column</TableHead>
            <TableHead className="hidden md:table-cell">Sample values</TableHead>
            <TableHead className="w-64">Import into</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {job.headers.map((header, index) => {
            const value = mapping[header] ?? "";
            const duplicate = Boolean(value) && (usedBy.get(value)?.length ?? 0) > 1;
            const selectId = `import-map-${index}`;
            const samples = sampleValues(job, header);
            return (
              <TableRow key={`${header}-${index}`}>
                <TableCell>
                  <Label htmlFor={selectId} className="block max-w-[12rem] truncate font-mono text-xs" title={header}>
                    {header || `Column ${index + 1}`}
                  </Label>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="block max-w-xs truncate text-xs text-fg-muted" title={samples}>
                    {samples || <span className="text-fg-subtle">(empty)</span>}
                  </span>
                </TableCell>
                <TableCell>
                  <Select
                    value={value || SKIP}
                    disabled={busy}
                    onValueChange={(next) => onChange({ ...draft, mapping: { ...mapping, [header]: next === SKIP ? "" : next } })}
                  >
                    <SelectTrigger id={selectId} aria-invalid={duplicate || undefined} className={cn(!value && "text-fg-subtle")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP}>Skip this column</SelectItem>
                      {targets.map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                          {key.startsWith("custom_data.") || key.startsWith("custom.") ? <span className="ml-1 text-xs text-fg-subtle">(custom)</span> : null}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor="import-dedupe">Duplicates</Label>
        <Select value={draft.dedupe} onValueChange={(v) => isDedupeMode(v) && onChange({ ...draft, dedupe: v })} disabled={busy}>
          <SelectTrigger id="import-dedupe">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEDUPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-fg-subtle">{draft.dedupe === "create" ? "Every row becomes a new record." : DEDUPE_MATCH[entity]}</p>
      </div>

      {supportsCreateCompanies(entity) ? (
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            id="import-create-companies"
            checked={draft.createCompanies}
            onCheckedChange={(checked) => onChange({ ...draft, createCompanies: checked })}
            disabled={busy}
          />
          <Label htmlFor="import-create-companies" className="cursor-pointer">
            Create companies that don&apos;t exist yet
          </Label>
          <span className="text-xs text-fg-subtle">(matched by name from the mapped company column)</span>
        </div>
      ) : null}

      <FormError message={error} />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} loading={check.isPending} disabled={suggest.isPending}>
          Check file
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ check result, progress, rollback */

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" | "warning" }) {
  return (
    <div>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd
        className={cn(
          "font-semibold",
          value > 0 && tone === "success" && "text-success",
          value > 0 && tone === "danger" && "text-danger",
          value > 0 && tone === "warning" && "text-warning",
        )}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

function CheckSummary({ entity, preview }: { entity: ImportEntity; preview: ImportPreview }) {
  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <Stat label="Rows checked" value={preview.rows_checked} />
        <Stat label="Will create" value={preview.would_create} tone="success" />
        <Stat label="Will update" value={preview.would_update} />
        <Stat label="Will skip" value={preview.would_skip} />
        <Stat label="Will fail" value={preview.would_fail} tone="danger" />
      </dl>
      {supportsCreateCompanies(entity) && preview.companies_to_create > 0 ? (
        <p className="text-xs text-fg-muted">
          {preview.companies_to_create.toLocaleString()} new {preview.companies_to_create === 1 ? "company" : "companies"} will be created.
        </p>
      ) : null}
      {preview.limit ? (
        <PlanLimitNotice
          title={`Your plan has room for ${preview.limit.capacity.toLocaleString()} more records; the import would stop at row ${preview.limit.stops_at_row.toLocaleString()}.`}
          detail={preview.limit.message || undefined}
          upgrade={preview.limit.upgrade}
        />
      ) : null}
      {preview.errors.length > 0 ? (
        <details open>
          <summary className="cursor-pointer text-sm font-medium">
            First problems ({preview.errors.length.toLocaleString()}
            {preview.would_fail > preview.errors.length ? ` of ${preview.would_fail.toLocaleString()} rows shown` : ""})
          </summary>
          <RowErrorsTable errors={preview.errors} />
        </details>
      ) : null}
    </div>
  );
}

/** "Roll back" with its confirmation. Shared by the job view and the history rows. */
export function RollbackAction({
  entity,
  job,
  onStarted,
}: {
  entity: ImportEntity;
  job: ImportJob;
  onStarted: (job: ImportJob) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const rollback = useMutation({
    mutationFn: () => rollbackImport(entity, job.id),
    onSuccess: (next) => {
      setOpen(false);
      onStarted(next);
    },
    onError: (err) => toast({ tone: "error", title: "Could not roll back", description: errorMessage(err) }),
  });
  if (!canRollBack(job)) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Undo2 /> Roll back
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Roll back “${job.original_filename || "this import"}”?`}
        description={`This deletes the ${job.created_rows.toLocaleString()} records it created and restores the ${job.updated_rows.toLocaleString()} it updated. Records changed since, or with notes, files or links, are left as they are and listed.`}
        confirmLabel="Roll back"
        destructive
        loading={rollback.isPending}
        onConfirm={() => rollback.mutate()}
      />
    </>
  );
}

/**
 * One import job, polled while it runs: the dry-run check result (then "Import"), the commit progress,
 * a clean stop at the plan limit, and the rollback.
 */
export function ImportJobView({
  entity,
  jobId,
  onBack,
  onEditMapping,
  onStatus,
}: {
  entity: ImportEntity;
  jobId: string;
  onBack: () => void;
  /** Present while the mapping chosen for this job is still in memory. */
  onEditMapping?: () => void;
  /** Called once for each settled status the job reaches. */
  onStatus: (job: ImportJob) => void;
}) {
  const queryClient = useQueryClient();
  const key = crmKeys.importJob(entity, jobId);
  const job = useQuery({
    queryKey: key,
    queryFn: () => getImport(entity, jobId),
    refetchInterval: (query) => (isActive(query.state.data?.status) ? POLL_MS : false),
  });
  const data = job.data;
  const status = data?.status;
  const seen = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!data || isActive(data.status)) return;
    const marker = `${data.id}:${data.status}`;
    if (seen.current === marker) return;
    seen.current = marker;
    onStatus(data);
  }, [data, onStatus]);

  const start = useMutation({
    mutationFn: () => startImport(entity, jobId),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });

  if (job.isPending) return <SkeletonRows rows={2} />;
  if (job.isError || !data) {
    return (
      <EmptyState
        title="Could not load this import"
        description={errorMessage(job.error)}
        action={
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        }
      />
    );
  }

  const header = (subtitle: string) => (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {status === "completed" || status === "previewed" || status === "rolled_back" ? (
            <CheckCircle2 className="size-4 text-success" aria-hidden />
          ) : status === "failed" ? (
            <XCircle className="size-4 text-danger" aria-hidden />
          ) : isActive(status) ? (
            <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
          ) : (
            <FileSpreadsheet className="size-4 text-fg-subtle" aria-hidden />
          )}
          <span className="truncate">{data.original_filename || "Import"}</span>
        </h3>
        <p className="text-xs text-fg-muted">{subtitle}</p>
      </div>
      <StatusBadge status={data.status} />
    </div>
  );

  const changeMapping = onEditMapping ? (
    <Button variant="secondary" onClick={onEditMapping} disabled={start.isPending}>
      Change mapping
    </Button>
  ) : null;

  // Checking, or the check failed (the job is back to "uploaded" with a message), or checked.
  if (status === "previewing" || status === "uploaded" || status === "previewed") {
    const preview = dryRun(data);
    return (
      <div className="grid gap-4 rounded-md border border-border bg-bg-subtle/40 p-4">
        {header(
          status === "previewing"
            ? "Checking every row in the background. Nothing is saved yet."
            : status === "previewed"
              ? "Check finished. Nothing has been saved yet."
              : "Not imported.",
        )}
        {status === "previewing" ? (
          <p role="status" aria-live="polite" className="text-sm text-fg-muted">
            Checking {data.total_rows.toLocaleString()} rows…
          </p>
        ) : null}
        {status === "uploaded" ? <FormError message={data.error_message || "The check did not finish. Try again."} /> : null}
        {status === "previewed" && preview ? <CheckSummary entity={entity} preview={preview} /> : null}
        <FormError message={start.isError ? errorMessage(start.error, "Could not start the import.") : null} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onBack} disabled={start.isPending}>
            Cancel
          </Button>
          {changeMapping}
          {status === "previewed" ? (
            <Button onClick={() => start.mutate()} loading={start.isPending} disabled={!preview || preview.rows_checked === preview.would_fail}>
              Import
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const total = Math.max(data.total_rows, data.processed_rows, 0);
  const finished = status === "completed" || status === "stopped" || status === "rolled_back" || status === "rolling_back";
  const percent = total > 0 ? Math.min(100, Math.round((data.processed_rows / total) * 100)) : finished ? 100 : 0;
  const running = isActive(status);
  const rollingBack = status === "rolling_back" || status === "rolled_back";

  return (
    <div className="grid gap-4 rounded-md border border-border bg-bg-subtle/40 p-4">
      {header(running ? "Running in the background; this page updates every few seconds." : data.finished_at ? `Finished ${formatDateTime(data.finished_at)}` : formatDateTime(data.created_at))}

      <div className="grid gap-1" role="status" aria-live="polite">
        <div className="flex justify-between text-xs text-fg-muted">
          <span>
            {data.processed_rows.toLocaleString()} of {total.toLocaleString()} rows processed
          </span>
          <span>{percent}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-border" aria-hidden>
          <div
            className={cn("h-full rounded-full transition-[width]", status === "failed" ? "bg-danger" : status === "stopped" ? "bg-warning" : "bg-primary")}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <Stat label="Created" value={data.created_rows} tone="success" />
        <Stat label="Updated" value={data.updated_rows} />
        <Stat label="Skipped" value={data.skipped_rows} />
        <Stat label="Errors" value={data.error_rows} tone="danger" />
        <Stat label="Total rows" value={data.total_rows} />
      </dl>

      {status === "stopped" ? (
        <PlanLimitNotice
          title={data.stop?.message || "The import stopped at your plan's record limit."}
          detail={data.stop?.row ? `Rows before row ${data.stop.row.toLocaleString()} were imported; the rest were not.` : undefined}
          upgrade={data.stop?.upgrade}
        />
      ) : null}

      {status === "failed" && data.error_message ? <FormError message={data.error_message} /> : null}

      {data.errors.length > 0 ? (
        <details open={!running}>
          <summary className="cursor-pointer text-sm font-medium">
            Row errors ({data.errors.length.toLocaleString()}
            {data.error_rows > data.errors.length ? ` of ${data.error_rows.toLocaleString()} shown` : ""})
          </summary>
          <RowErrorsTable errors={data.errors} />
        </details>
      ) : null}

      {rollingBack ? <RollbackSummary job={data} /> : null}

      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button variant="secondary" size="sm" onClick={() => job.refetch()} loading={job.isFetching}>
            <RefreshCw /> Refresh now
          </Button>
        ) : null}
        <RollbackAction entity={entity} job={data} onStarted={(next) => queryClient.setQueryData(key, next)} />
        <Button variant={running ? "ghost" : "secondary"} size="sm" onClick={onBack}>
          {running ? "Back" : "Import another file"}
        </Button>
      </div>
    </div>
  );
}
